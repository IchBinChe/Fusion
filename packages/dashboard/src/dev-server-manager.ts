import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import {
  loadDevServerStore,
  resetDevServerStore,
  type DevServerPersistedLogEntry,
  type DevServerPersistedState,
  type DevServerStatus,
  type DevServerLogSource,
  type DevServerStore,
} from "./dev-server-store.js";
import { SessionEventBuffer, type SessionBufferedEvent } from "./sse-buffer.js";

const DEFAULT_SERVER_KEY = "default";
const DEFAULT_LOG_LIMIT = 200;
const DEFAULT_BUFFER_CAPACITY = 400;
const STOP_TIMEOUT_MS = 5_000;

// Reserved dashboard port 4040 must never be suggested as a fallback dev-server port.
export const FALLBACK_PORTS = [3000, 4173, 5173, 6006, 8080, 4200, 4400, 8888] as const;

export interface DevServerStartOptions {
  command: string;
  cwd?: string;
  scriptName?: string | null;
}

export interface DevServerSnapshot {
  state: DevServerPersistedState;
  logs: DevServerPersistedLogEntry[];
}

export interface DevServerManagerEvent {
  type: "state" | "log";
  data: DevServerPersistedState | DevServerPersistedLogEntry;
}

type DevServerSubscriber = (event: DevServerManagerEvent, eventId: number) => void;

export class DevServerManager extends EventEmitter {
  private readonly subscribers = new Set<DevServerSubscriber>();
  private readonly eventBuffer = new SessionEventBuffer(DEFAULT_BUFFER_CAPACITY);
  private readonly logLimit: number;

  private process: ChildProcessWithoutNullStreams | null = null;
  private stopPromise: Promise<void> | null = null;
  private state: DevServerPersistedState;
  private logs: DevServerPersistedLogEntry[] = [];
  private initialized = false;
  private persistenceChain = Promise.resolve();

  constructor(
    private readonly rootDir: string,
    private readonly store: DevServerStore,
    options?: { logLimit?: number },
  ) {
    super();
    this.logLimit = options?.logLimit ?? DEFAULT_LOG_LIMIT;
    this.state = createDefaultState();
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const loadedState = await this.store.loadState();
    this.logs = await this.store.readLogTail(this.logLimit);

    if (loadedState) {
      this.state = loadedState;
    }

    await this.reconcilePersistedProcessState();
    this.initialized = true;
  }

  getState(): DevServerPersistedState {
    return structuredClone(this.state);
  }

  getRecentLogs(limit = this.logLimit): DevServerPersistedLogEntry[] {
    if (!Number.isFinite(limit) || limit <= 0) {
      return [];
    }
    return this.logs.slice(-Math.floor(limit)).map((entry) => structuredClone(entry));
  }

  getSnapshot(limit = this.logLimit): DevServerSnapshot {
    return {
      state: this.getState(),
      logs: this.getRecentLogs(limit),
    };
  }

  getBufferedEvents(sinceId: number): SessionBufferedEvent[] {
    return this.eventBuffer.getEventsSince(sinceId);
  }

  subscribe(callback: DevServerSubscriber): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async start(options: DevServerStartOptions): Promise<DevServerPersistedState> {
    await this.ensureInitialized();

    const command = options.command.trim();
    if (!command) {
      throw new Error("command is required");
    }

    if (this.state.pid && isProcessAlive(this.state.pid) && (this.state.status === "running" || this.state.status === "starting")) {
      return this.getState();
    }

    if (this.state.pid && !isProcessAlive(this.state.pid)) {
      await this.setState({
        status: "stopped",
        pid: null,
        exitCode: 1,
        exitSignal: null,
        exitedAt: new Date().toISOString(),
        failureReason: "Persisted process is no longer running",
      });
    }

    const cwd = options.cwd ? resolve(options.cwd) : this.rootDir;
    const now = new Date().toISOString();

    await this.setState({
      status: "starting",
      command,
      scriptName: options.scriptName ?? null,
      cwd,
      startedAt: now,
      exitedAt: null,
      exitCode: null,
      exitSignal: null,
      failureReason: null,
      previewUrl: null,
      previewProtocol: null,
      previewHost: null,
      previewPort: null,
      previewPath: null,
      pid: null,
    });

    this.appendLog({
      serverKey: DEFAULT_SERVER_KEY,
      source: "system",
      message: `Starting dev server: ${command}`,
      timestamp: now,
    });

    const child = spawn(command, {
      cwd,
      shell: true,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process = child;

    await this.setState({ pid: child.pid ?? null });

    child.once("spawn", () => {
      void this.setState({ status: "running" });
    });

    child.once("error", (error) => {
      const failedAt = new Date().toISOString();
      this.appendLog({
        serverKey: DEFAULT_SERVER_KEY,
        source: "system",
        message: `Dev server failed to start: ${error.message}`,
        timestamp: failedAt,
      });
      void this.setState({
        status: "failed",
        pid: null,
        exitCode: 1,
        exitSignal: null,
        exitedAt: failedAt,
        failureReason: error.message,
      });
      this.process = null;
    });

    child.once("exit", (code, signal) => {
      const exitedAt = new Date().toISOString();
      const failed = (code ?? 0) !== 0;
      this.appendLog({
        serverKey: DEFAULT_SERVER_KEY,
        source: "system",
        message: failed
          ? `Dev server exited with code ${code ?? "unknown"}`
          : "Dev server stopped",
        timestamp: exitedAt,
      });
      void this.setState({
        status: failed ? "failed" : "stopped",
        pid: null,
        exitCode: code ?? null,
        exitSignal: signal ?? null,
        exitedAt,
        failureReason: failed ? `Process exited with code ${code ?? "unknown"}` : null,
      });
      this.process = null;
    });

    this.pipeOutput(child, "stdout");
    this.pipeOutput(child, "stderr");

    return this.getState();
  }

  async stop(reason = "Stopped by user"): Promise<DevServerPersistedState> {
    await this.ensureInitialized();

    if (this.stopPromise) {
      await this.stopPromise;
      return this.getState();
    }

    this.stopPromise = this.stopInternal(reason)
      .finally(() => {
        this.stopPromise = null;
      });

    await this.stopPromise;
    return this.getState();
  }

  async restart(options: DevServerStartOptions): Promise<DevServerPersistedState> {
    await this.stop("Restarting dev server");
    return this.start(options);
  }

  async shutdown(): Promise<void> {
    if (this.process || (this.state.pid && isProcessAlive(this.state.pid))) {
      await this.stop("Dashboard backend shutting down");
    }
    await this.flushPersistence();
  }

  resetForTests(): void {
    this.subscribers.clear();
    this.eventBuffer.clear();
    this.logs = [];
    this.process = null;
    this.stopPromise = null;
    this.state = createDefaultState();
    this.initialized = false;
    this.persistenceChain = Promise.resolve();
  }

  private async stopInternal(reason: string): Promise<void> {
    const now = new Date().toISOString();
    this.appendLog({
      serverKey: DEFAULT_SERVER_KEY,
      source: "system",
      message: reason,
      timestamp: now,
    });

    const currentPid = this.process?.pid ?? this.state.pid;

    if (!currentPid) {
      await this.setState({
        status: "stopped",
        pid: null,
        exitCode: 0,
        exitSignal: null,
        exitedAt: now,
        failureReason: null,
      });
      return;
    }

    if (!isProcessAlive(currentPid)) {
      await this.setState({
        status: "stopped",
        pid: null,
        exitCode: 0,
        exitSignal: null,
        exitedAt: now,
        failureReason: null,
      });
      return;
    }

    try {
      process.kill(currentPid, "SIGTERM");
    } catch {
      // process may have already exited
    }

    const gracefulStop = waitForProcessExit(currentPid, STOP_TIMEOUT_MS);
    const exited = await gracefulStop;

    if (!exited) {
      try {
        process.kill(currentPid, "SIGKILL");
      } catch {
        // already gone
      }
    }

    await this.setState({
      status: "stopped",
      pid: null,
      exitCode: 0,
      exitSignal: exited ? "SIGTERM" : "SIGKILL",
      exitedAt: new Date().toISOString(),
      failureReason: null,
    });
  }

  private pipeOutput(processRef: ChildProcessWithoutNullStreams, source: DevServerLogSource): void {
    const stream = source === "stdout" ? processRef.stdout : processRef.stderr;
    const rl = createInterface({ input: stream });

    rl.on("line", (line) => {
      const message = line.trim();
      if (!message) {
        return;
      }

      const timestamp = new Date().toISOString();
      this.appendLog({
        serverKey: DEFAULT_SERVER_KEY,
        source,
        message,
        timestamp,
      });

      const detectedPreview = detectPreviewUrl(message);
      if (detectedPreview) {
        const parsed = parsePreviewUrl(detectedPreview);
        if (parsed) {
          void this.setState({
            status: "running",
            previewUrl: parsed.previewUrl,
            previewProtocol: parsed.previewProtocol,
            previewHost: parsed.previewHost,
            previewPort: parsed.previewPort,
            previewPath: parsed.previewPath,
          });
        }
      }
    });
  }

  private appendLog(entry: DevServerPersistedLogEntry): void {
    this.logs.push(entry);
    if (this.logs.length > this.logLimit) {
      this.logs.splice(0, this.logs.length - this.logLimit);
    }

    void this.enqueuePersistence(async () => {
      await this.store.appendLog(entry);
    });

    this.broadcast({ type: "log", data: entry });
  }

  private async setState(patch: Partial<DevServerPersistedState>): Promise<void> {
    this.state = {
      ...this.state,
      ...patch,
      serverKey: DEFAULT_SERVER_KEY,
      updatedAt: new Date().toISOString(),
    };

    await this.enqueuePersistence(async () => {
      await this.store.saveState(this.state);
    });

    this.broadcast({ type: "state", data: this.state });
  }

  private broadcast(event: DevServerManagerEvent): number {
    const payload = JSON.stringify(event.data);
    const eventId = this.eventBuffer.push(event.type, payload);

    for (const subscriber of this.subscribers) {
      try {
        subscriber(event, eventId);
      } catch {
        // Ignore per-subscriber failures.
      }
    }

    this.emit("event", event, eventId);
    return eventId;
  }

  private async reconcilePersistedProcessState(): Promise<void> {
    const shouldVerify = this.state.status === "running" || this.state.status === "starting";
    if (!shouldVerify || !this.state.pid) {
      return;
    }

    if (isProcessAlive(this.state.pid)) {
      return;
    }

    await this.setState({
      status: "stopped",
      pid: null,
      exitCode: 1,
      exitSignal: null,
      exitedAt: new Date().toISOString(),
      failureReason: "Recovered process is no longer running",
    });

    this.appendLog({
      serverKey: DEFAULT_SERVER_KEY,
      source: "system",
      message: "Recovered stale persisted PID and marked server as stopped",
      timestamp: new Date().toISOString(),
    });
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  private async enqueuePersistence(operation: () => Promise<void>): Promise<void> {
    this.persistenceChain = this.persistenceChain
      .then(operation)
      .catch(() => {
        // Keep the chain alive even if one write fails.
      });

    await this.persistenceChain;
  }

  private async flushPersistence(): Promise<void> {
    await this.persistenceChain;
  }
}

function createDefaultState(): DevServerPersistedState {
  return {
    serverKey: DEFAULT_SERVER_KEY,
    status: "idle",
    command: null,
    scriptName: null,
    cwd: null,
    pid: null,
    startedAt: null,
    updatedAt: new Date().toISOString(),
    previewUrl: null,
    previewProtocol: null,
    previewHost: null,
    previewPort: null,
    previewPath: null,
    exitCode: null,
    exitSignal: null,
    exitedAt: null,
    failureReason: null,
  };
}

function detectPreviewUrl(message: string): string | null {
  const match = message.match(/https?:\/\/[^\s]+/i);
  return match?.[0] ?? null;
}

function parsePreviewUrl(urlValue: string): {
  previewUrl: string;
  previewProtocol: string;
  previewHost: string;
  previewPort: number | null;
  previewPath: string;
} | null {
  try {
    const parsed = new URL(urlValue);
    return {
      previewUrl: parsed.toString(),
      previewProtocol: parsed.protocol.replace(/:$/, ""),
      previewHost: parsed.hostname,
      previewPort: parsed.port ? Number.parseInt(parsed.port, 10) : null,
      previewPath: parsed.pathname || "/",
    };
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const intervalMs = 100;
  const maxChecks = Math.ceil(timeoutMs / intervalMs);

  for (let i = 0; i < maxChecks; i += 1) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, intervalMs);
    });
  }

  return !isProcessAlive(pid);
}

const managerInstances = new Map<string, DevServerManager>();

export async function loadDevServerManager(rootDir: string): Promise<DevServerManager> {
  const key = resolve(rootDir);
  let manager = managerInstances.get(key);

  if (!manager) {
    const store = await loadDevServerStore(rootDir);
    manager = new DevServerManager(key, store);
    managerInstances.set(key, manager);
    await manager.initialize();
  }

  return manager;
}

export async function shutdownAllDevServerManagers(): Promise<void> {
  for (const manager of managerInstances.values()) {
    await manager.shutdown();
  }
}

export function resetDevServerManager(): void {
  managerInstances.clear();
  resetDevServerStore();
}
