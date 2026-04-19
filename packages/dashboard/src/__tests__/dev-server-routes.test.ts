// @vitest-environment node

import express from "express";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskStore } from "@fusion/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiRoutes } from "../routes.js";
import { request as REQUEST, get as GET } from "../test-request.js";
import { DevServerStore, projectDevServerLogFile, projectDevServerStateFile } from "../dev-server-store.js";
import { resetDevServerManager, shutdownAllDevServerManagers } from "../dev-server-manager.js";

function createMockGlobalSettingsStore() {
  return {
    getSettings: vi.fn().mockResolvedValue({}),
    updateSettings: vi.fn().mockResolvedValue({}),
    getSettingsPath: vi.fn().mockReturnValue("/fake/home/.fusion/settings.json"),
    init: vi.fn().mockResolvedValue(false),
  };
}

function createMockMissionStore() {
  return {
    createSession: vi.fn().mockResolvedValue({ id: "session-1", status: "active" }),
    getSession: vi.fn().mockResolvedValue({ id: "session-1", status: "active", answers: [] }),
    updateSession: vi.fn().mockResolvedValue(undefined),
    addAnswer: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    listSessions: vi.fn().mockResolvedValue([]),
    generatePlan: vi.fn().mockResolvedValue({ plan: "Test plan", steps: [] }),
  };
}

function createMockStore(rootDir: string, overrides: Partial<TaskStore> = {}): TaskStore {
  return {
    getTask: vi.fn(),
    listTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(),
    moveTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    mergeTask: vi.fn(),
    archiveTask: vi.fn(),
    unarchiveTask: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({ scripts: {} }),
    updateSettings: vi.fn(),
    updateGlobalSettings: vi.fn(),
    getSettingsByScope: vi.fn().mockResolvedValue({ global: {}, project: {} }),
    getGlobalSettingsStore: vi.fn().mockReturnValue(createMockGlobalSettingsStore()),
    logEntry: vi.fn().mockResolvedValue(undefined),
    getAgentLogs: vi.fn().mockResolvedValue([]),
    addComment: vi.fn(),
    addTaskComment: vi.fn(),
    updateTaskComment: vi.fn(),
    deleteTaskComment: vi.fn(),
    updatePrInfo: vi.fn().mockResolvedValue(undefined),
    updateIssueInfo: vi.fn().mockResolvedValue(undefined),
    getRootDir: vi.fn().mockReturnValue(rootDir),
    listWorkflowSteps: vi.fn().mockResolvedValue([]),
    createWorkflowStep: vi.fn(),
    getWorkflowStep: vi.fn(),
    updateWorkflowStep: vi.fn(),
    deleteWorkflowStep: vi.fn(),
    getMissionStore: vi.fn().mockReturnValue(createMockMissionStore()),
    ...overrides,
  } as unknown as TaskStore;
}

function buildApp(store: TaskStore): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  return app;
}

async function waitForAsync(predicate: () => Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("Dev server routes", () => {
  beforeEach(() => {
    resetDevServerManager();
  });

  afterEach(async () => {
    await shutdownAllDevServerManagers();
    resetDevServerManager();
  });

  it("hydrates persisted status and history after manager cache reset", async () => {
    const root = await mkdtemp(join(tmpdir(), "dev-server-routes-"));
    const persistedStore = new DevServerStore(projectDevServerStateFile(root), projectDevServerLogFile(root));

    await persistedStore.saveState({
      serverKey: "default",
      status: "running",
      command: "pnpm dev",
      scriptName: "dev",
      cwd: root,
      pid: 999_999,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      previewUrl: "http://127.0.0.1:5173",
      previewProtocol: "http",
      previewHost: "127.0.0.1",
      previewPort: 5173,
      previewPath: "/",
      exitCode: null,
      exitSignal: null,
      exitedAt: null,
      failureReason: null,
    });
    await persistedStore.appendLog({
      serverKey: "default",
      source: "stdout",
      message: "ready http://127.0.0.1:5173",
      timestamp: new Date().toISOString(),
    });

    const app = buildApp(createMockStore(root));

    const statusRes = await GET(app, "/api/dev-server/status");
    expect(statusRes.status).toBe(200);
    expect((statusRes.body as any).state.status).toBe("stopped");
    expect((statusRes.body as any).logs).toHaveLength(2);

    const historyRes = await GET(app, "/api/dev-server/history?limit=10");
    expect(historyRes.status).toBe(200);
    expect((historyRes.body as any).logs.some((entry: { message: string }) => entry.message.includes("ready"))).toBe(true);
  });

  it("starts and stops dev server through HTTP endpoints", async () => {
    const root = await mkdtemp(join(tmpdir(), "dev-server-routes-"));
    const app = buildApp(createMockStore(root));

    const script = "console.log('ready http://127.0.0.1:4288'); setInterval(() => {}, 1000);";

    const startRes = await REQUEST(
      app,
      "POST",
      "/api/dev-server/start",
      JSON.stringify({ command: `node -e \"${script}\"`, scriptName: "dev" }),
      { "Content-Type": "application/json" },
    );

    expect(startRes.status).toBe(200);

    await waitForAsync(async () => {
      const statusRes = await GET(app, "/api/dev-server/status");
      return (statusRes.body as any).state.status === "running";
    });

    await waitForAsync(async () => {
      const history = await GET(app, "/api/dev-server/history?limit=20");
      return (history.body as any).logs.some((entry: { message: string }) =>
        entry.message.includes("ready http://127.0.0.1:4288"),
      );
    });

    const stopRes = await REQUEST(app, "POST", "/api/dev-server/stop");
    expect(stopRes.status).toBe(200);
    expect((stopRes.body as any).state.status).toBe("stopped");
  });
});
