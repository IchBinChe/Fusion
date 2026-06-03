// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "@fusion/core";
import { createApiRoutes } from "../routes.js";
import { get } from "../test-request.js";

describe("task log routes with file-backed agent logs", () => {
  let rootDir: string;
  let store: TaskStore;
  let app: express.Express;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "fusion-dashboard-agent-log-routes-"));
    store = new TaskStore(rootDir, join(rootDir, ".fusion-global-settings"), { inMemoryDb: true });
    await store.init();
    app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
  });

  afterEach(() => {
    store.close();
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("GET /api/tasks/:id/logs returns file-backed entries with count headers", async () => {
    const task = await store.createTask({ description: "Route reads file-backed agent logs" });
    await store.appendAgentLog(task.id, "first", "text", undefined, "executor");
    await store.appendAgentLog(task.id, "second", "tool", "detail-2", "executor");
    await store.appendAgentLog(task.id, "third", "tool_result", "detail-3", "executor");

    const expected = await store.getAgentLogs(task.id, { limit: 2 });
    const agentLogPath = join(rootDir, ".fusion", "tasks", task.id, "agent-log.jsonl");
    expect(existsSync(agentLogPath)).toBe(true);

    const res = await get(app, `/api/tasks/${task.id}/logs?limit=2`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expected);
    expect(res.headers["x-total-count"]).toBe("3");
    expect(res.headers["x-has-more"]).toBe("true");
  });
});
