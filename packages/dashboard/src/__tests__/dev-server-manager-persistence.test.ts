// @vitest-environment node

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DevServerManager,
  resetDevServerManager,
  type DevServerStartOptions,
} from "../dev-server-manager.js";
import {
  DevServerStore,
  projectDevServerLogFile,
  projectDevServerStateFile,
  type DevServerPersistedState,
} from "../dev-server-store.js";

function createState(overrides: Partial<DevServerPersistedState> = {}): DevServerPersistedState {
  return {
    serverKey: "default",
    status: "stopped",
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
    exitCode: 0,
    exitSignal: null,
    exitedAt: new Date().toISOString(),
    failureReason: null,
    ...overrides,
  };
}

async function createManager(rootDir: string): Promise<{ manager: DevServerManager; store: DevServerStore }> {
  const store = new DevServerStore(projectDevServerStateFile(rootDir), projectDevServerLogFile(rootDir));
  const manager = new DevServerManager(rootDir, store, { logLimit: 50 });
  await manager.initialize();
  return { manager, store };
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function longRunningCommand(previewUrl = "http://127.0.0.1:4173/preview"): DevServerStartOptions {
  const script = `console.log('ready ${previewUrl}'); setInterval(() => {}, 1000);`;
  return {
    command: `node -e \"${script}\"`,
    scriptName: "dev",
  };
}

describe("DevServerManager persistence", () => {
  const runningManagers: DevServerManager[] = [];

  afterEach(async () => {
    for (const manager of runningManagers.splice(0)) {
      try {
        await manager.shutdown();
      } catch {
        // ignore cleanup failures
      }
    }
    resetDevServerManager();
  });

  it("rehydrates persisted state and reconciles stale PIDs", async () => {
    const root = await mkdtemp(join(tmpdir(), "dev-server-manager-"));
    const store = new DevServerStore(projectDevServerStateFile(root), projectDevServerLogFile(root));

    await store.saveState(createState({
      status: "running",
      pid: 999_999,
      command: "pnpm dev",
      startedAt: new Date().toISOString(),
      exitCode: null,
      exitedAt: null,
    }));

    const manager = new DevServerManager(root, store);
    runningManagers.push(manager);
    await manager.initialize();

    const state = manager.getState();
    expect(state.status).toBe("stopped");
    expect(state.pid).toBeNull();
    expect(state.failureReason).toContain("Recovered process is no longer running");
  });

  it("persists lifecycle transitions and stdout logs while running", async () => {
    const root = await mkdtemp(join(tmpdir(), "dev-server-manager-"));
    const { manager, store } = await createManager(root);
    runningManagers.push(manager);

    await manager.start(longRunningCommand());

    await waitFor(() => manager.getState().previewUrl !== null);

    const state = manager.getState();
    expect(state.status).toBe("running");
    expect(state.previewUrl).toContain("http://127.0.0.1:4173/preview");
    expect(typeof state.pid).toBe("number");

    const persistedState = await store.loadState();
    expect(persistedState?.status).toBe("running");
    expect(persistedState?.previewHost).toBe("127.0.0.1");

    const logs = await store.readLogTail(20);
    expect(logs.some((entry) => entry.message.includes("ready http://127.0.0.1:4173/preview"))).toBe(true);

    await manager.stop();
    expect(manager.getState().status).toBe("stopped");
  });

  it("restores persisted logs into in-memory snapshot on startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "dev-server-manager-"));
    const store = new DevServerStore(projectDevServerStateFile(root), projectDevServerLogFile(root));
    await store.appendLogs([
      {
        serverKey: "default",
        source: "system",
        message: "first",
        timestamp: "2026-04-19T12:00:00.000Z",
      },
      {
        serverKey: "default",
        source: "stdout",
        message: "second",
        timestamp: "2026-04-19T12:00:01.000Z",
      },
    ]);

    const manager = new DevServerManager(root, store, { logLimit: 10 });
    runningManagers.push(manager);
    await manager.initialize();

    expect(manager.getRecentLogs().map((entry) => entry.message)).toEqual(["first", "second"]);
  });

  it("restart stops existing process and spawns a fresh PID", async () => {
    const root = await mkdtemp(join(tmpdir(), "dev-server-manager-"));
    const { manager } = await createManager(root);
    runningManagers.push(manager);

    await manager.start(longRunningCommand("http://127.0.0.1:4180"));
    await waitFor(() => manager.getState().status === "running" && manager.getState().pid !== null);
    const firstPid = manager.getState().pid;

    await manager.restart(longRunningCommand("http://127.0.0.1:4181"));
    await waitFor(() => manager.getState().previewUrl?.includes("4181") ?? false);
    const secondPid = manager.getState().pid;

    expect(firstPid).not.toBeNull();
    expect(secondPid).not.toBeNull();
    expect(secondPid).not.toBe(firstPid);
  });
});
