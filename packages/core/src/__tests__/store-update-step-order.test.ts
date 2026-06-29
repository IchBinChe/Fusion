import { beforeAll, beforeEach, afterEach, afterAll, describe, expect, it } from "vitest";
import { createSharedTaskStoreTestHarness } from "./store-test-helpers.js";

describe("TaskStore.updateStep step-order guard", () => {
  const harness = createSharedTaskStoreTestHarness();

  beforeAll(harness.beforeAll);
  beforeEach(harness.beforeEach);
  afterEach(harness.afterEach);
  afterAll(harness.afterAll);

  it("no-ops out-of-order done updates when an earlier step is pending", async () => {
    const store = harness.store();
    const task = await harness.createTaskWithSteps();

    await store.updateStep(task.id, 0, "done");
    const updated = await store.updateStep(task.id, 2, "done");

    expect(updated.steps[2].status).toBe("pending");
    expect(updated.log.some((entry) => entry.action.includes("Ignored out-of-order done for step 2"))).toBe(true);
  });

  it("allows done when prior steps are skipped", async () => {
    const store = harness.store();
    const task = await harness.createTaskWithSteps();

    await store.updateStep(task.id, 0, "done");
    await store.updateStep(task.id, 1, "skipped");
    const updated = await store.updateStep(task.id, 2, "done");

    expect(updated.steps[2].status).toBe("done");
    expect(updated.currentStep).toBe(3);
  });

  it("allows done when prior steps are done and advances currentStep", async () => {
    const store = harness.store();
    const task = await harness.createTaskWithSteps();

    await store.updateStep(task.id, 0, "done");
    await store.updateStep(task.id, 1, "done");
    const updated = await store.updateStep(task.id, 2, "done");

    expect(updated.steps[2].status).toBe("done");
    expect(updated.currentStep).toBe(3);
  });

  it("keeps done→in-progress regression guard behavior", async () => {
    const store = harness.store();
    const task = await harness.createTaskWithSteps();

    await store.updateStep(task.id, 0, "done");
    const updated = await store.updateStep(task.id, 0, "in-progress");

    expect(updated.steps[0].status).toBe("done");
    expect(updated.log.some((entry) => entry.action.includes("Ignored done→in-progress regression"))).toBe(true);
  });

  // ── U6: graph-source projection discipline (KTD-7/KTD-11) ──────────────────

  it("graph source: done is legal for independent steps even when an earlier step is in-progress", async () => {
    // Graph-owned step sessions can complete independent steps out of index order.
    // Missing dependsOn means the graph/wave planner already decided the step was
    // runnable; TaskStore must not invent a hidden previous-step dependency.
    const store = harness.store();
    const task = await harness.createTaskWithSteps();

    await store.updateStep(task.id, 1, "in-progress", { source: "graph" });
    const updated = await store.updateStep(task.id, 2, "done", { source: "graph" });

    expect(updated.steps[2].status).toBe("done");
    expect(updated.steps[1].status).toBe("in-progress");
    expect(updated.log.some((e) => e.action.includes("Ignored out-of-order done for step 2"))).toBe(false);
  });

  it("graph source: explicit dependsOn still suppresses completion until dependencies finish", async () => {
    const store = harness.store();
    const task = await harness.createTaskWithSteps();
    const steps = task.steps.map((s, i) => (i === 2 ? { ...s, dependsOn: [1] } : { ...s }));
    await store.updateTask(task.id, { steps });

    await store.updateStep(task.id, 1, "in-progress", { source: "graph" });
    const updated = await store.updateStep(task.id, 2, "done", { source: "graph" });

    expect(updated.steps[2].status).toBe("pending");
    expect(
      updated.log.some((e) => e.action.includes("Ignored dependency-order done for step 2")),
    ).toBe(true);
  });

  it("graph source: out-of-order done (unmet dependency) is suppressed AND audited loudly", async () => {
    const store = harness.store();
    const task = await harness.createTaskWithSteps();
    const steps = task.steps.map((s, i) => (i === 1 ? { ...s, dependsOn: [0] } : { ...s }));
    await store.updateTask(task.id, { steps });
    await store.updateStep(task.id, 1, "in-progress");

    const updated = await store.updateStep(task.id, 1, "done", { source: "graph" });

    // Suppressed: step 1's explicit dependency (step 0) is still pending, so the
    // done write is rejected and step 1 keeps its prior (non-done) status.
    expect(updated.steps[1].status).not.toBe("done");
    expect(
      updated.log.some((e) => e.action.includes("Ignored dependency-order done for step 1")),
    ).toBe(true);
    // Graph suppression is surfaced loudly (not the legacy silent ignore).
    expect(
      updated.log.some((e) => e.action.includes("[integrity-warning] graph-source updateStep suppressed")),
    ).toBe(true);
  });

  it("legacy source: silent out-of-order ignore behavior is unchanged (no integrity-warning)", async () => {
    const store = harness.store();
    const task = await harness.createTaskWithSteps();

    await store.updateStep(task.id, 0, "done");
    const updated = await store.updateStep(task.id, 2, "done"); // legacy, no source

    expect(updated.steps[2].status).toBe("pending");
    expect(updated.log.some((e) => e.action.includes("Ignored out-of-order done for step 2"))).toBe(true);
    // Legacy stays silent — no integrity-warning emitted.
    expect(updated.log.some((e) => e.action.includes("[integrity-warning]"))).toBe(false);
  });

  it("graph source: auto-reinit from PROMPT.md is bypassed (explicit indices only)", async () => {
    // A fresh task with no JSON steps would, under legacy semantics, parse steps
    // from PROMPT.md on the first updateStep. Graph source bypasses that — so an
    // index into an unparsed (empty) step list is out of range and rejects.
    const store = harness.store();
    const task = await store.createTask({ description: "graph reinit bypass" });
    // No PROMPT.md steps are written; task.steps starts empty.

    await expect(store.updateStep(task.id, 0, "in-progress", { source: "graph" })).rejects.toThrow(
      /out of range/,
    );

    // Legacy path on the same empty task would attempt the PROMPT.md reinit
    // instead of bypassing — proving the divergence is graph-source-only. (Here
    // there is no PROMPT.md either, so legacy also has zero steps and rejects,
    // but via the auto-init path rather than the bypass.)
    await expect(store.updateStep(task.id, 0, "in-progress")).rejects.toThrow(/out of range/);
  });
});
