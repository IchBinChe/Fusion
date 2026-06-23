import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUILTIN_CODING_WORKFLOW_IR,
  TaskStore,
  resolveSeamPromptFromIr,
  resolveTaskSeamPrompt,
  type WorkflowIr,
} from "@fusion/core";

let rootDir: string;
let globalDir: string;
let store: TaskStore;

type StoreWithSyncWorkflowResolution = TaskStore & {
  resolveTaskWorkflowIrSync(taskId: string): WorkflowIr;
};

describe("workflow prompt override resolution", () => {
  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "fusion-engine-prompt-overrides-"));
    globalDir = await mkdtemp(join(tmpdir(), "fusion-engine-prompt-overrides-global-"));
    store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await store.init();
  });

  afterEach(async () => {
    store.stopWatching();
    await store.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await rm(globalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("applies and resets built-in execute seam prompt overrides without mutating the shared IR", async () => {
    const projectId = store.getWorkflowSettingsProjectId();
    const defaultExecutePrompt = resolveSeamPromptFromIr(BUILTIN_CODING_WORKFLOW_IR, "execute");
    const beforeStaticIr = JSON.stringify(BUILTIN_CODING_WORKFLOW_IR);
    const task = await store.createTask({ description: "uses prompt override", workflowId: "builtin:coding" });

    // FNXC:CustomWorkflows 2026-06-21-21:04:
    // Engine seam resolution must consume the same built-in prompt override overlay as dashboard preview and sync store resolution, while reset-to-default must reveal the shipped static prompt again.
    store.updateWorkflowPromptOverrides("builtin:coding", projectId, { execute: "Engine execute override" });

    expect(await resolveTaskSeamPrompt(store, task.id, "execute")).toBe("Engine execute override");
    const syncIr = (store as StoreWithSyncWorkflowResolution).resolveTaskWorkflowIrSync(task.id);
    expect(resolveSeamPromptFromIr(syncIr, "execute")).toBe("Engine execute override");
    expect(syncIr).not.toBe(BUILTIN_CODING_WORKFLOW_IR);
    expect(JSON.stringify(BUILTIN_CODING_WORKFLOW_IR)).toBe(beforeStaticIr);

    store.updateWorkflowPromptOverrides("builtin:coding", projectId, { execute: null });

    expect(await resolveTaskSeamPrompt(store, task.id, "execute")).toBe(defaultExecutePrompt);
    expect(resolveSeamPromptFromIr((store as StoreWithSyncWorkflowResolution).resolveTaskWorkflowIrSync(task.id), "execute")).toBe(
      defaultExecutePrompt,
    );
    expect(JSON.stringify(BUILTIN_CODING_WORKFLOW_IR)).toBe(beforeStaticIr);
  });
});
