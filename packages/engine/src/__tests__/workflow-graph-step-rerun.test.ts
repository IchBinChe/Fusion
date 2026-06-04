// -nocheck
import { describe, it, expect, beforeEach, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";
import type { Task } from "@fusion/core";

/**
 * FIX 3: runGraphTaskStep single-flight-per-attempt + rejection memo clearing.
 *
 * The implementation phase is memoized once per run (graphStepRunOnce) so each
 * foreach instance's runStep observes the projection instead of re-running the
 * agent. Two regressions are covered:
 *   - a REJECTED phase must clear the memo so a rework cycle RE-INVOKES the
 *     implementation (the prior code re-awaited the stored rejection forever);
 *   - the projection consult must NOT mask a step-session failure: a non-terminal
 *     step with no deferred review returns success:false (the prior code returned
 *     success on both branches).
 */
describe("runGraphTaskStep (FIX 3)", () => {
  beforeEach(() => resetExecutorMocks());

  function makeExecutor(stepStatus: string | undefined, active?: { deferDoneToReview?: boolean }) {
    const store = createMockStore();
    store.getTask = vi.fn().mockResolvedValue({
      id: "FN-001",
      steps: stepStatus ? [{ name: "S1", status: stepStatus }] : [{ name: "S1", status: "pending" }],
    });
    const executor: any = new TaskExecutor(store, "/tmp/test", {});
    // Stamp the active foreach context the seam would normally stamp.
    if (active) executor.graphStepActiveContext.set("FN-001", { stepIndex: 0, ...active });
    return { executor, store };
  }

  const task = { id: "FN-001" } as Task;

  it("re-invokes the implementation after a rejected phase (rework retries)", async () => {
    const { executor } = makeExecutor("pending", { deferDoneToReview: true });
    let calls = 0;
    executor.runImplementationPhase = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error("impl failed");
      return { taskDone: true, modifiedFiles: [] };
    });

    // First attempt: implementation rejects → failure, memo cleared.
    const first = await executor.runGraphTaskStep(task, 0);
    expect(first.success).toBe(false);
    expect(calls).toBe(1);

    // Rework re-run: the memo was cleared, so the implementation is invoked AGAIN
    // (the bug left a poisoned rejected promise that was re-awaited forever).
    const second = await executor.runGraphTaskStep(task, 0);
    expect(calls).toBe(2);
    expect(second.success).toBe(true);
  });

  it("single-flight within one attempt: concurrent callers share one phase", async () => {
    const { executor } = makeExecutor("done");
    let calls = 0;
    executor.runImplementationPhase = vi.fn().mockImplementation(async () => {
      calls += 1;
      await Promise.resolve();
      return { taskDone: true, modifiedFiles: [] };
    });
    const [a, b] = await Promise.all([
      executor.runGraphTaskStep(task, 0),
      executor.runGraphTaskStep(task, 0),
    ]);
    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    expect(calls).toBe(1); // memoized — exactly one implementation pass.
  });

  it("does NOT mask a step-session failure: non-terminal step without review → failure", async () => {
    const { executor } = makeExecutor("in-progress"); // never reaches done/skipped, no deferDoneToReview
    executor.runImplementationPhase = vi.fn().mockResolvedValue({ taskDone: false, modifiedFiles: [] });
    const result = await executor.runGraphTaskStep(task, 0);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not completed/);
  });

  it("deferDoneToReview: a non-terminal step is success (review authors done)", async () => {
    const { executor } = makeExecutor("in-progress", { deferDoneToReview: true });
    executor.runImplementationPhase = vi.fn().mockResolvedValue({ taskDone: false, modifiedFiles: [] });
    const result = await executor.runGraphTaskStep(task, 0);
    expect(result.success).toBe(true);
  });

  it("terminal step (done) is success regardless of review", async () => {
    const { executor } = makeExecutor("done");
    executor.runImplementationPhase = vi.fn().mockResolvedValue({ taskDone: true, modifiedFiles: [] });
    const result = await executor.runGraphTaskStep(task, 0);
    expect(result.success).toBe(true);
  });
});
