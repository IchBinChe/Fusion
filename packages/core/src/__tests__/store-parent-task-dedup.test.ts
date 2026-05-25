import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTaskStoreTestHarness } from "./store-test-helpers.js";

describe("TaskStore parent-task duplicate intake", () => {
  const harness = createTaskStoreTestHarness();
  let store = harness.store();

  beforeEach(async () => {
    await harness.beforeEach();
    store = harness.store();
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  it("auto-archives a sibling created by the same parent task with similar description", async () => {
    const parentId = "FN-PARENT";

    const first = await store.createTask({
      title: "Add structured run-audit event for per-lane provider/runtime selection",
      description:
        "Add structured run-audit event recording per-lane provider/runtime selection (FN-5206 deferral)",
      column: "triage",
      source: {
        sourceType: "agent_heartbeat",
        sourceAgentId: "agent-alpha",
        sourceParentTaskId: parentId,
      },
    });

    const second = await store.createTask({
      title: "Emit run-audit event capturing lane provider/runtime selection",
      description:
        "Emit a structured run-audit event capturing per-lane provider/runtime selection for FN-5206 deferral",
      column: "triage",
      source: {
        // Different agent — but same parent. Should still dedup.
        sourceType: "agent_heartbeat",
        sourceAgentId: "agent-beta",
        sourceParentTaskId: parentId,
      },
    });

    const refreshed = await store.getTask(second.id);
    expect(refreshed.column).toBe("archived");

    const firstRefreshed = await store.getTask(first.id);
    expect(firstRefreshed.column).toBe("triage");
  });

  it("does not archive siblings with different parent tasks", async () => {
    await store.createTask({
      title: "Add structured run-audit event",
      description: "Add structured run-audit event recording per-lane provider/runtime selection",
      column: "triage",
      source: {
        sourceType: "agent_heartbeat",
        sourceAgentId: "agent-alpha",
        sourceParentTaskId: "FN-PARENT-A",
      },
    });

    const second = await store.createTask({
      title: "Add structured run-audit event",
      description: "Add structured run-audit event recording per-lane provider/runtime selection",
      column: "triage",
      source: {
        sourceType: "agent_heartbeat",
        sourceAgentId: "agent-beta",
        sourceParentTaskId: "FN-PARENT-B",
      },
    });

    const refreshed = await store.getTask(second.id);
    expect(refreshed.column).toBe("triage");
  });
});
