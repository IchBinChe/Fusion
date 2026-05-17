import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentStore, TaskStore } from "@fusion/core";
import { createServer } from "../server.js";
import { get } from "../test-request.js";

describe("GET /api/agents/:id/prompt-sizes integration", () => {
  let rootDir: string;
  let store: TaskStore;
  let agentId: string;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "fn-4928-prompt-sizes-"));
    store = new TaskStore(rootDir, join(rootDir, ".fusion-global-settings"));
    await store.init();

    const agentStore = new AgentStore({ rootDir: store.getFusionDir() });
    await agentStore.init();

    const agent = await agentStore.createAgent({
      name: "Prompt Sizes Agent",
      role: "executor",
      metadata: {},
    });
    agentId = agent.id;

    await agentStore.saveRun({
      id: "run-prompt-size-1",
      agentId,
      startedAt: "2026-05-17T12:00:00.000Z",
      endedAt: "2026-05-17T12:00:01.000Z",
      status: "completed",
      systemPrompt: "sys prompt",
      executionPrompt: "execute now",
    });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("returns prompt-size rows derived from startedAt and run JSON", async () => {
    const app = createServer(store);
    const okRes = await get(app, `/api/agents/${agentId}/prompt-sizes`);
    expect(okRes.status).toBe(200);
    expect(okRes.body).toEqual([
      {
        runId: "run-prompt-size-1",
        createdAt: "2026-05-17T12:00:00.000Z",
        systemChars: "sys prompt".length,
        execChars: "execute now".length,
        totalChars: "sys prompt".length + "execute now".length,
      },
    ]);
  });
});
