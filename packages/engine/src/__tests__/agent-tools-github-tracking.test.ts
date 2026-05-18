import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskStore, setTaskCreatedHook, type Task } from "@fusion/core";
import { createTaskCreateTool, createDelegateTaskTool } from "../agent-tools.js";

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("agent task creation github-tracking hook integration", () => {
  let rootDir: string;
  let globalDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    setTaskCreatedHook(undefined);
    rootDir = makeTmpDir("kb-engine-agent-tools-gh-track-");
    globalDir = makeTmpDir("kb-engine-agent-tools-gh-track-global-");
    store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await store.init();
  });

  afterEach(async () => {
    setTaskCreatedHook(undefined);
    store.close();
    await rm(rootDir, { recursive: true, force: true });
    await rm(globalDir, { recursive: true, force: true });
  });

  it("calls the post-create hook for fn_task_create", async () => {
    const hook = vi.fn(async (_task: Task) => {});
    setTaskCreatedHook(hook);

    const tool = createTaskCreateTool(store);
    const result = await tool.execute("call-1", { description: "agent-created triage task" } as never, undefined, undefined, {} as never);

    expect(result.details).toHaveProperty("taskId");
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      description: "agent-created triage task",
      column: "triage",
    }));
  });

  it("calls the post-create hook for fn_delegate_task", async () => {
    const hook = vi.fn(async (_task: Task) => {});
    setTaskCreatedHook(hook);

    const agentStore = {
      getAgent: vi.fn().mockResolvedValue({ id: "agent-1", name: "Worker", role: "executor", state: "idle" }),
    };

    const tool = createDelegateTaskTool(agentStore as never, store);
    const result = await tool.execute("call-1", {
      agent_id: "agent-1",
      description: "delegated tracked task",
    } as never, undefined, undefined, {} as never);

    expect(result.details).toEqual(expect.objectContaining({ taskId: expect.any(String), agentId: "agent-1" }));
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      description: "delegated tracked task",
      assignedAgentId: "agent-1",
      column: "todo",
    }));
  });
});
