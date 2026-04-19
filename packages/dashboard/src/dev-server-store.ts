import { access, appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export type DevServerStatus = "idle" | "starting" | "running" | "stopped" | "failed";

export interface DevServerPersistedState {
  serverKey: string;
  status: DevServerStatus;
  command: string | null;
  scriptName: string | null;
  cwd: string | null;
  pid: number | null;
  startedAt: string | null;
  updatedAt: string;
  previewUrl: string | null;
  previewProtocol: string | null;
  previewHost: string | null;
  previewPort: number | null;
  previewPath: string | null;
  exitCode: number | null;
  exitSignal: string | null;
  exitedAt: string | null;
  failureReason: string | null;
}

export type DevServerLogSource = "stdout" | "stderr" | "system";

export interface DevServerPersistedLogEntry {
  serverKey: string;
  source: DevServerLogSource;
  message: string;
  timestamp: string;
}

interface DevServerStateFile {
  version: 1;
  state: DevServerPersistedState;
}

function devServerFusionDir(rootDir: string): string {
  return join(resolve(rootDir), ".fusion");
}

export function projectDevServerStateFile(rootDir: string): string {
  return join(devServerFusionDir(rootDir), "dev-server-state.json");
}

export function projectDevServerLogFile(rootDir: string): string {
  return join(devServerFusionDir(rootDir), "dev-server.log");
}

export class DevServerStore {
  private state: DevServerPersistedState | null = null;

  constructor(
    readonly stateFilePath: string,
    readonly logFilePath: string,
  ) {}

  async loadState(): Promise<DevServerPersistedState | null> {
    try {
      const raw = await readFile(this.stateFilePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<DevServerStateFile>;
      const state = parsed?.state;
      if (!state || typeof state !== "object") {
        this.state = null;
        return null;
      }

      const normalized = normalizePersistedState(state as Partial<DevServerPersistedState>);
      if (!normalized) {
        this.state = null;
        return null;
      }

      this.state = normalized;
      return structuredClone(normalized);
    } catch {
      this.state = null;
      return null;
    }
  }

  getState(): DevServerPersistedState | null {
    return this.state ? structuredClone(this.state) : null;
  }

  async saveState(state: DevServerPersistedState): Promise<void> {
    const normalized = normalizePersistedState(state);
    if (!normalized) {
      throw new Error("Invalid dev-server persisted state");
    }

    const payload: DevServerStateFile = {
      version: 1,
      state: normalized,
    };

    await mkdirDirForFile(this.stateFilePath);

    const tempPath = `${this.stateFilePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
    await rename(tempPath, this.stateFilePath);

    this.state = normalized;
  }

  async appendLog(entry: DevServerPersistedLogEntry): Promise<void> {
    const normalized = normalizeLogEntry(entry);
    if (!normalized) {
      return;
    }

    await mkdirDirForFile(this.logFilePath);
    await appendFile(this.logFilePath, `${JSON.stringify(normalized)}\n`, "utf-8");
  }

  async appendLogs(entries: DevServerPersistedLogEntry[]): Promise<void> {
    const normalized = entries
      .map((entry) => normalizeLogEntry(entry))
      .filter((entry): entry is DevServerPersistedLogEntry => entry !== null);

    if (normalized.length === 0) {
      return;
    }

    await mkdirDirForFile(this.logFilePath);
    const payload = normalized.map((entry) => JSON.stringify(entry)).join("\n");
    await appendFile(this.logFilePath, `${payload}\n`, "utf-8");
  }

  async readLogTail(limit = 200): Promise<DevServerPersistedLogEntry[]> {
    if (!Number.isFinite(limit) || limit <= 0) {
      return [];
    }

    try {
      const raw = await readFile(this.logFilePath, "utf-8");
      const lines = raw.split("\n").filter((line) => line.trim().length > 0);
      const tail = lines.slice(-Math.floor(limit));
      const parsed: DevServerPersistedLogEntry[] = [];
      for (const line of tail) {
        try {
          const maybeEntry = JSON.parse(line) as Partial<DevServerPersistedLogEntry>;
          const normalized = normalizeLogEntry(maybeEntry);
          if (normalized) {
            parsed.push(normalized);
          }
        } catch {
          // Ignore malformed lines to keep reads tolerant.
        }
      }
      return parsed;
    } catch {
      return [];
    }
  }

  async clearState(): Promise<void> {
    this.state = null;
    await rm(this.stateFilePath, { force: true });
  }

  async clearLogs(): Promise<void> {
    await rm(this.logFilePath, { force: true });
  }
}

async function mkdirDirForFile(filePath: string): Promise<void> {
  const lastSlash = filePath.lastIndexOf("/");
  const dir = lastSlash >= 0 ? filePath.slice(0, lastSlash) : filePath;

  try {
    await access(dir);
  } catch {
    await mkdir(dir, { recursive: true });
  }
}

function normalizePersistedState(state: Partial<DevServerPersistedState>): DevServerPersistedState | null {
  const status = normalizeStatus(state.status);
  const serverKey = typeof state.serverKey === "string" && state.serverKey.trim().length > 0
    ? state.serverKey.trim()
    : "default";

  const updatedAt = normalizeDateString(state.updatedAt) ?? new Date().toISOString();

  if (!status) {
    return null;
  }

  return {
    serverKey,
    status,
    command: normalizeNullableString(state.command),
    scriptName: normalizeNullableString(state.scriptName),
    cwd: normalizeNullableString(state.cwd),
    pid: normalizeNullableNumber(state.pid),
    startedAt: normalizeDateString(state.startedAt),
    updatedAt,
    previewUrl: normalizeNullableString(state.previewUrl),
    previewProtocol: normalizeNullableString(state.previewProtocol),
    previewHost: normalizeNullableString(state.previewHost),
    previewPort: normalizeNullableNumber(state.previewPort),
    previewPath: normalizeNullableString(state.previewPath),
    exitCode: normalizeNullableNumber(state.exitCode),
    exitSignal: normalizeNullableString(state.exitSignal),
    exitedAt: normalizeDateString(state.exitedAt),
    failureReason: normalizeNullableString(state.failureReason),
  };
}

function normalizeLogEntry(entry: Partial<DevServerPersistedLogEntry>): DevServerPersistedLogEntry | null {
  const message = normalizeNullableString(entry.message);
  if (!message) {
    return null;
  }

  const source = normalizeSource(entry.source);
  if (!source) {
    return null;
  }

  const timestamp = normalizeDateString(entry.timestamp) ?? new Date().toISOString();
  const serverKey = typeof entry.serverKey === "string" && entry.serverKey.trim().length > 0
    ? entry.serverKey.trim()
    : "default";

  return {
    serverKey,
    source,
    message,
    timestamp,
  };
}

function normalizeStatus(value: unknown): DevServerStatus | null {
  if (value === "idle" || value === "starting" || value === "running" || value === "stopped" || value === "failed") {
    return value;
  }
  return null;
}

function normalizeSource(value: unknown): DevServerLogSource | null {
  if (value === "stdout" || value === "stderr" || value === "system") {
    return value;
  }
  return null;
}

function normalizeNullableString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeNullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeDateString(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}

const storeInstances = new Map<string, DevServerStore>();

export async function loadDevServerStore(rootDir: string): Promise<DevServerStore> {
  const stateFile = projectDevServerStateFile(rootDir);
  let store = storeInstances.get(stateFile);
  if (!store) {
    store = new DevServerStore(stateFile, projectDevServerLogFile(rootDir));
    storeInstances.set(stateFile, store);
    await store.loadState();
  }
  return store;
}

export function resetDevServerStore(): void {
  storeInstances.clear();
}
