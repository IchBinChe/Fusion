import { describe, expect, it, vi } from "vitest";
import type { TaskDetail } from "@fusion/core";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";

const now = "2026-06-23T00:00:00.000Z";

function task(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-GRAPH-REQUEUE",
    title: "Graph execute recovery",
    description: "Gate coverage for execute-node self-requeue preservation",
    column: "in-progress",
    dependencies: [],
    steps: [{ name: "Implement", status: "pending" }],
    currentStep: 0,
    log: [],
    branch: "fusion/fn-graph-requeue",
    baseBranch: "main",
    worktree: "/tmp/fusion-fn-graph-requeue",
    status: null,
    error: null,
    paused: false,
    userPaused: false,
    autoMerge: true,
    mergeRetries: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as TaskDetail;
}

describe("executor graph execute self-requeue gate", () => {
  it("preserves executor todo recovery when the live refetch is stale in-progress", async () => {
    resetExecutorMocks();
    const store = createMockStore();
    const live = task({ column: "in-progress" });
    store.getTask.mockResolvedValue(live);
    store.getSettings.mockResolvedValue({
      autoMerge: true,
      maxAutoMergeRetries: 3,
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
    });
    const executor = new TaskExecutor(store, "/tmp/test");

    /*
    FNXC:WorkflowLifecycle 2026-06-23-23:03:
    The workflow cutover gate must directly cover the graph execute self-requeue guard. A stale live `in-progress` refetch after an inner executor moved the task to `todo` must not be parked in review or marked failed.
    */
    (executor as any).graphRouting.add(live.id);
    (executor as any).markGraphExecuteSelfRequeued(live.id);
    try {
      await (executor as any).handleGraphFailure(live, {
        disposition: "failed",
        outcome: "failure",
        visitedNodeIds: ["execute"],
        context: { "node:execute:value": "recoverable" },
      });
    } finally {
      (executor as any).graphRouting.delete(live.id);
    }

    expect(store.logEntry).toHaveBeenCalledWith(
      live.id,
      expect.stringContaining("executor recovery preserved"),
      undefined,
      undefined,
    );
    expect(store.moveTask).not.toHaveBeenCalledWith(live.id, "in-review", expect.anything());
    expect(store.updateTask).not.toHaveBeenCalledWith(
      live.id,
      expect.objectContaining({ status: "failed" }),
      expect.anything(),
    );
  });
});
