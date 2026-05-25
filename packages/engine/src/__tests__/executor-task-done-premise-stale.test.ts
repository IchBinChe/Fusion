import { describe, expect, it } from "vitest";
import { evaluateTaskDoneRefusal } from "../executor.js";

function createTask(stepStatuses: Array<"done" | "skipped" | "pending" | "in-progress">) {
  return {
    id: "FN-PREMISE-STALE",
    title: "Premise stale",
    description: "",
    column: "in-progress",
    dependencies: [],
    steps: stepStatuses.map((status, index) => ({ name: `Step ${index + 1}`, status })),
    currentStep: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as any;
}

describe("preflight PREMISE STALE: escape hatch", () => {
  it("allows fn_task_done when summary starts with PREMISE STALE: even if it contains 'done' near 'the task'", () => {
    // Without the bypass, the scoped-incomplete regex matches 'done' and the
    // 40-char window contains 'the task' → would refuse with
    // summary-claims-incomplete. The bypass must let this through.
    const task = createTask(["done", "skipped", "skipped", "skipped", "skipped"]);
    const result = evaluateTaskDoneRefusal(
      task,
      { summary: "PREMISE STALE: the task has no remaining work — implementation is already done on HEAD" },
      new Map(),
    );
    expect(result).toEqual({ ok: true });
  });

  it("allows fn_task_done when summary starts with PREMISE STALE: and contains 'I'm blocked' style dissent phrasing", () => {
    // Natural premise-stale phrasing may accidentally include a dissent-pattern
    // word ("blocked from", "to unblock", "requires follow-up"). The bypass
    // must not refuse on the dissent regex when the sentinel is present.
    const task = createTask(["done", "skipped", "skipped"]);
    const result = evaluateTaskDoneRefusal(
      task,
      { summary: "PREMISE STALE: targeted reproduction passes on HEAD; nothing to unblock and no further work required" },
      new Map(),
    );
    expect(result).toEqual({ ok: true });
  });

  it("is case-insensitive on the sentinel", () => {
    const task = createTask(["done", "skipped"]);
    const result = evaluateTaskDoneRefusal(
      task,
      { summary: "premise stale: this task is not done because main already shipped it" },
      new Map(),
    );
    expect(result).toEqual({ ok: true });
  });

  it("does NOT bypass when sentinel appears later in the summary (must be at start)", () => {
    // Defends against agents tacking the sentinel into the middle to dodge a
    // genuine incomplete-work refusal.
    const task = createTask(["done", "pending"]);
    const result = evaluateTaskDoneRefusal(
      task,
      { summary: "The task is not done yet, but PREMISE STALE: I think it's stale anyway" },
      new Map(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusalClass).toBe("summary-claims-incomplete");
    }
  });

  it("still enforces pending-code-review-revise even with the sentinel", () => {
    // The bypass only relaxes the summary-text checks. A genuine REVISE verdict
    // on an in-progress step must still block fn_task_done.
    const task = createTask(["done", "in-progress"]);
    const verdicts = new Map<number, "REVISE">([[1, "REVISE"]]);
    const result = evaluateTaskDoneRefusal(
      task,
      { summary: "PREMISE STALE: already done on HEAD" },
      verdicts as any,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusalClass).toBe("pending-code-review-revise");
    }
  });
});
