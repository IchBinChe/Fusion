// @vitest-environment node

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DevServerStore,
  loadDevServerStore,
  projectDevServerLogFile,
  projectDevServerStateFile,
  resetDevServerStore,
  type DevServerPersistedState,
} from "../dev-server-store.js";

function createState(overrides: Partial<DevServerPersistedState> = {}): DevServerPersistedState {
  return {
    serverKey: "default",
    status: "running",
    command: "pnpm dev",
    scriptName: "dev",
    cwd: "/repo",
    pid: 12345,
    startedAt: "2026-04-19T12:00:00.000Z",
    updatedAt: "2026-04-19T12:01:00.000Z",
    previewUrl: "http://localhost:5173",
    previewProtocol: "http",
    previewHost: "localhost",
    previewPort: 5173,
    previewPath: "/",
    exitCode: null,
    exitSignal: null,
    exitedAt: null,
    failureReason: null,
    ...overrides,
  };
}

describe("DevServerStore", () => {
  afterEach(() => {
    resetDevServerStore();
  });

  it("persists state atomically and loads it back", async () => {
    const root = await mkdtemp(join(tmpdir(), "dev-server-store-"));
    const store = new DevServerStore(projectDevServerStateFile(root), projectDevServerLogFile(root));

    const input = createState();
    await store.saveState(input);

    const loaded = await store.loadState();
    expect(loaded).toEqual(input);

    const stateFileText = await readFile(projectDevServerStateFile(root), "utf-8");
    expect(stateFileText).toContain('"version": 1');
    expect(stateFileText).toContain('"status": "running"');
  });

  it("returns null for missing or corrupt state file", async () => {
    const root = await mkdtemp(join(tmpdir(), "dev-server-store-"));
    const store = new DevServerStore(projectDevServerStateFile(root), projectDevServerLogFile(root));

    expect(await store.loadState()).toBeNull();

    await mkdir(join(root, ".fusion"), { recursive: true });
    await writeFile(projectDevServerStateFile(root), "{invalid-json", "utf-8");
    expect(await store.loadState()).toBeNull();
  });

  it("normalizes invalid persisted fields instead of throwing", async () => {
    const root = await mkdtemp(join(tmpdir(), "dev-server-store-"));
    const store = new DevServerStore(projectDevServerStateFile(root), projectDevServerLogFile(root));

    await mkdir(join(root, ".fusion"), { recursive: true });
    await writeFile(
      projectDevServerStateFile(root),
      JSON.stringify({
        version: 1,
        state: {
          serverKey: "",
          status: "running",
          command: "pnpm dev",
          pid: "9876",
          startedAt: "not-a-date",
          updatedAt: "2026-04-19T12:01:00.000Z",
        },
      }),
      "utf-8",
    );

    const loaded = await store.loadState();
    expect(loaded?.serverKey).toBe("default");
    expect(loaded?.pid).toBe(9876);
    expect(loaded?.startedAt).toBeNull();
  });

  it("appends logs and returns tolerant tail", async () => {
    const root = await mkdtemp(join(tmpdir(), "dev-server-store-"));
    const store = new DevServerStore(projectDevServerStateFile(root), projectDevServerLogFile(root));

    await store.appendLog({
      serverKey: "default",
      source: "system",
      message: "booting",
      timestamp: "2026-04-19T12:00:00.000Z",
    });
    await store.appendLogs([
      {
        serverKey: "default",
        source: "stdout",
        message: "ready in 150ms",
        timestamp: "2026-04-19T12:00:01.000Z",
      },
      {
        serverKey: "default",
        source: "stderr",
        message: "warning",
        timestamp: "2026-04-19T12:00:02.000Z",
      },
    ]);

    await writeFile(projectDevServerLogFile(root), "{bad-line}\n", { flag: "a" });

    const tailTwo = await store.readLogTail(2);
    expect(tailTwo).toHaveLength(1);
    expect(tailTwo[0]?.message).toBe("warning");

    const all = await store.readLogTail(20);
    expect(all.map((entry) => entry.message)).toEqual(["booting", "ready in 150ms", "warning"]);
  });

  it("reuses singleton instances per project root", async () => {
    const rootA = await mkdtemp(join(tmpdir(), "dev-server-store-a-"));
    const rootB = await mkdtemp(join(tmpdir(), "dev-server-store-b-"));

    const a1 = await loadDevServerStore(rootA);
    const a2 = await loadDevServerStore(rootA);
    const b1 = await loadDevServerStore(rootB);

    expect(a1).toBe(a2);
    expect(a1).not.toBe(b1);

    resetDevServerStore();

    const a3 = await loadDevServerStore(rootA);
    expect(a3).not.toBe(a1);
  });
});
