import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";
import type { TaskDetail } from "@fusion/core";

const now = "2026-06-20T00:00:00.000Z";

function makeTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-6782-T",
    title: "pause-abort benign todo repro",
    description: "Reproduces FN-6782 benign requeue-to-todo classification",
    column: "todo",
    dependencies: [],
    steps: [{ name: "Implement", status: "pending" }],
    currentStep: 0,
    log: [],
    branch: null,
    baseBranch: "main",
    worktree: "/tmp/fusion-fn-6782-t",
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

type AbortProvenance = "hard-cancel" | "global-pause" | "merge-seam" | "completion-finalize";

function makeHarness(
  taskOverrides: Partial<TaskDetail> = {},
  provenance: AbortProvenance = "hard-cancel",
) {
  const store = createMockStore();
  const task = makeTask(taskOverrides);
  store.getTask.mockResolvedValue(task);
  store.getSettings.mockResolvedValue({
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 15000,
    autoMerge: true,
    maxAutoMergeRetries: 3,
  });
  const executor = new TaskExecutor(store, "/tmp/test", {});
  (executor as any).markPausedAborted(task.id, provenance);
  return { store, task, executor };
}

async function invokeGraphFailure(executor: TaskExecutor, task: TaskDetail) {
  await (executor as any).handleGraphFailure(task, {
    disposition: "failed",
    outcome: "failure",
    visitedNodeIds: ["plan", "execute"],
    context: {},
  });
}

// Flush the unref'd setTimeout that schedules the in-place retry plus the async
// re-fetch + execute() chain inside it. Fake timers keep this deterministic
// (no real wall-clock wait) per the repo's no-slow-tests rule (FN-5048).
async function flushScheduledRetry() {
  await vi.advanceTimersByTimeAsync(10);
}

function logText(store: ReturnType<typeof createMockStore>): string {
  return store.logEntry.mock.calls.map((call: unknown[]) => call[1]).join("\n");
}

describe("pause-abort benign requeue-to-todo (FN-6782)", () => {
  beforeEach(() => {
    resetExecutorMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("auto-continues the agent session for an engine-internal abort instead of re-queueing to todo", async () => {
    // An "engine abort during pause/resume" (pausedAborted hard-cancel, no user/
    // global pause) is engine-internal churn, not an operator action — the
    // executor must retry the agent session in place rather than bouncing the
    // task through todo (and must not fire a failure notification).
    const { store, task, executor } = makeHarness({ column: "todo" });
    (executor as any).addActiveWorktree(task.id, task.worktree);
    const executeSpy = vi
      .spyOn(executor as any, "execute")
      .mockResolvedValue(undefined);

    await invokeGraphFailure(executor, task);

    // It must NOT park status:"failed" — that was the storm trigger.
    const parkedFailed = store.updateTask.mock.calls.some(
      (call: unknown[]) => (call[1] as { status?: string } | undefined)?.status === "failed",
    );
    expect(parkedFailed).toBe(false);
    // It auto-continues instead of logging the benign re-queue line.
    expect(logText(store)).toContain("auto-continuing the agent session (1/2)");
    expect(logText(store)).not.toContain("benign, cleared for normal scheduling");
    // The bounded retry budget is incremented and any stale failure cleared.
    const bumpedRetry = store.updateTask.mock.calls.some(
      (call: unknown[]) => {
        const patch = call[1] as { graphResumeRetryCount?: number; status?: unknown } | undefined;
        return patch?.graphResumeRetryCount === 1 && patch?.status === null;
      },
    );
    expect(bumpedRetry).toBe(true);
    // An `Auto-recovered:`-prefixed log suppresses the failure notification.
    expect(logText(store)).toContain("Auto-recovered: engine-internal pause/resume abort");
    // The pause-abort marker is cleared and the worktree slot released.
    expect((executor as any).pausedAborted.has(task.id)).toBe(false);
    expect((executor as any).activeWorktrees.has(task.id)).toBe(false);
    // The agent session is re-executed in place after the backoff window.
    await flushScheduledRetry();
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "paused", patch: { paused: true } },
    { label: "user-paused", patch: { userPaused: true } },
    { label: "moved out of todo", patch: { column: "in-progress" } },
    { label: "deleted", patch: { deletedAt: "2026-06-21T00:00:00.000Z" } },
  ])(
    "fire-time guard: aborts the auto-continue when the task became $label during the backoff window",
    async ({ patch }) => {
      // The auto-continue re-fetches the task just before re-executing and must
      // bail if the operator paused/moved/deleted it during the backoff window —
      // the direct execute() bypasses the scheduler's pause filter, so without
      // this guard it would resume work the user just parked. The initial
      // `live` snapshot is a clean todo (so the auto-continue branch is entered
      // and a retry scheduled); the task then changes state before the timer
      // fires, and the fire-time re-fetch must abort the dispatch.
      const { store, task, executor } = makeHarness({ column: "todo" });
      (executor as any).addActiveWorktree(task.id, task.worktree);
      const executeSpy = vi.spyOn(executor as any, "execute").mockResolvedValue(undefined);

      await invokeGraphFailure(executor, task);
      // The auto-continue branch was entered and a retry scheduled...
      expect(logText(store)).toContain("auto-continuing the agent session");

      // ...but the task changed state before the scheduled retry fires; the
      // fire-time re-fetch returns the mutated snapshot.
      store.getTask.mockResolvedValue({ ...task, ...patch } as typeof task);
      await flushScheduledRetry();

      expect(executeSpy).not.toHaveBeenCalled();
    },
  );

  it("clears a stale failed status when auto-continuing an engine-internal abort (no lingering failure notification)", async () => {
    // A pause-abort parked status:"failed" on an earlier non-todo observation
    // stays dispatchable (scheduler filters column+paused, not status) and
    // re-enters this branch in todo. Auto-continue must reconcile the row to
    // status:null/error:null — otherwise the persisted failure survives, the
    // board shows it failed, and the deferred failure notification fires.
    const { store, task, executor } = makeHarness({
      column: "todo",
      status: "failed",
      error: "Workflow graph failure surfaced after paused engine abort during pause/resume",
    });
    (executor as any).addActiveWorktree(task.id, task.worktree);
    const executeSpy = vi.spyOn(executor as any, "execute").mockResolvedValue(undefined);

    await invokeGraphFailure(executor, task);

    const clearedFailure = store.updateTask.mock.calls.some(
      (call: unknown[]) => {
        const patch = call[1] as { status?: unknown; error?: unknown } | undefined;
        return patch?.status === null && patch?.error === null;
      },
    );
    expect(clearedFailure).toBe(true);
    const reParkedFailed = store.updateTask.mock.calls.some(
      (call: unknown[]) => (call[1] as { status?: string } | undefined)?.status === "failed",
    );
    expect(reParkedFailed).toBe(false);
    expect(logText(store)).toContain("auto-continuing the agent session");
    expect(logText(store)).toContain("Auto-recovered: engine-internal pause/resume abort");
    await flushScheduledRetry();
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "explicit user pause", overrides: { column: "todo", userPaused: true }, provenance: "hard-cancel" as const },
    { label: "global pause", overrides: { column: "todo" }, provenance: "global-pause" as const },
  ])(
    "does NOT auto-resume a $label that landed in todo",
    async ({ overrides, provenance }) => {
      // The auto-continue is scoped strictly to the engine-internal abort
      // provenance. A genuine operator pause (userPaused) or a global engine
      // pause that ended up in todo must stay parked-benign and wait for
      // explicit resume — auto-resuming it would override the operator's intent.
      const { store, task, executor } = makeHarness(overrides, provenance);
      (executor as any).addActiveWorktree(task.id, task.worktree);
      const executeSpy = vi.spyOn(executor as any, "execute").mockResolvedValue(undefined);

      await invokeGraphFailure(executor, task);

      expect(logText(store)).toContain("benign, cleared for normal scheduling");
      expect(logText(store)).not.toContain("auto-continuing the agent session");
      await flushScheduledRetry();
      expect(executeSpy).not.toHaveBeenCalled();
    },
  );

  it("falls back to a benign todo re-queue once internal retries are exhausted", async () => {
    // After MAX_TRANSIENT_GRAPH_RESUME_RETRIES (2) internal retries, a still-
    // wedged engine-internal abort must stop auto-continuing and fall through to
    // the benign re-queue (no failure notification, no retry storm).
    const { store, task, executor } = makeHarness({
      column: "todo",
      graphResumeRetryCount: 2,
    });
    (executor as any).addActiveWorktree(task.id, task.worktree);
    const executeSpy = vi
      .spyOn(executor as any, "execute")
      .mockResolvedValue(undefined);

    await invokeGraphFailure(executor, task);

    expect(logText(store)).toContain("benign, cleared for normal scheduling");
    expect(logText(store)).not.toContain("auto-continuing the agent session");
    const parkedFailed = store.updateTask.mock.calls.some(
      (call: unknown[]) => (call[1] as { status?: string } | undefined)?.status === "failed",
    );
    expect(parkedFailed).toBe(false);
    await flushScheduledRetry();
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("clears a stale failed status on the retries-exhausted benign fallback", async () => {
    // The retries-exhausted fallback shares the benign re-queue's stale-failure
    // reconciliation: a row carrying status:"failed" from an earlier non-todo
    // observation must be cleared and emit the `Auto-recovered:` log so the
    // deferred failure notification is suppressed even when auto-continue is
    // exhausted.
    const { store, task, executor } = makeHarness({
      column: "todo",
      graphResumeRetryCount: 2,
      status: "failed",
      error: "Workflow graph failure surfaced after paused engine abort during pause/resume",
    });
    (executor as any).addActiveWorktree(task.id, task.worktree);

    await invokeGraphFailure(executor, task);

    expect(logText(store)).toContain("benign, cleared for normal scheduling");
    expect(logText(store)).toContain(
      "Auto-recovered: cleared stale pause-abort failure on todo re-queue",
    );
    const clearedFailure = store.updateTask.mock.calls.some(
      (call: unknown[]) => {
        const patch = call[1] as { status?: unknown; error?: unknown } | undefined;
        return patch?.status === null && patch?.error === null;
      },
    );
    expect(clearedFailure).toBe(true);
  });

  it("STILL parks a non-todo (in-review) pause-abort as operator-action failed", async () => {
    const { store, task, executor } = makeHarness({ column: "in-review" });

    await invokeGraphFailure(executor, task);

    const parkedFailed = store.updateTask.mock.calls.some(
      (call: unknown[]) => (call[1] as { status?: string } | undefined)?.status === "failed",
    );
    expect(parkedFailed).toBe(true);
    expect(logText(store)).toContain("operator action required");
  });
});
