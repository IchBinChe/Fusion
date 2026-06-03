import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTaskStoreTestHarness } from "./store-test-helpers.js";

describe("TaskStore file-backed agent logs", () => {
  const harness = createTaskStoreTestHarness();

  beforeEach(async () => {
    await harness.beforeEach();
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  it("preserves append, read, count, pagination, and time-range parity", async () => {
    const store = harness.store();
    const task = await harness.createTestTask();

    harness.insertLogEntryWithTimestamp(
      store,
      task.id,
      "first",
      "text",
      "2026-01-01T00:00:00.000Z",
    );
    harness.insertLogEntryWithTimestamp(
      store,
      task.id,
      "tool",
      "tool",
      "2026-01-01T00:01:00.000Z",
      "readme.md",
      "executor",
    );
    harness.insertLogEntryWithTimestamp(
      store,
      task.id,
      "third",
      "thinking",
      "2026-01-01T00:02:00.000Z",
      undefined,
      "reviewer",
    );

    await expect(store.getAgentLogCount(task.id)).resolves.toBe(3);
    await expect(store.getAgentLogs(task.id)).resolves.toMatchObject([
      { text: "first", type: "text" },
      { text: "tool", type: "tool", detail: "readme.md", agent: "executor" },
      { text: "third", type: "thinking", agent: "reviewer" },
    ]);
    await expect(store.getAgentLogs(task.id, { limit: 2 })).resolves.toMatchObject([
      { text: "tool" },
      { text: "third" },
    ]);
    await expect(store.getAgentLogs(task.id, { limit: 2, offset: 2 })).resolves.toMatchObject([
      { text: "first" },
    ]);
    await expect(
      store.getAgentLogsByTimeRange(task.id, "2026-01-01T00:01:00.000Z", "2026-01-01T00:02:00.000Z"),
    ).resolves.toMatchObject([{ text: "tool" }, { text: "third" }]);
  });

  it("emits SSE-facing agent:log events per single and batch append while skipping persistence for deleted tasks", async () => {
    const store = harness.store();
    const liveTask = await harness.createTestTask();
    const deletedTask = await harness.createTestTask();
    const events: Array<{ taskId: string; text: string }> = [];
    store.on("agent:log", (entry) => events.push({ taskId: entry.taskId, text: entry.text }));

    await store.deleteTask(deletedTask.id);
    await store.appendAgentLog(liveTask.id, "live-single", "text");
    await store.appendAgentLog(deletedTask.id, "deleted-single", "text");
    await store.appendAgentLogBatch([
      { taskId: liveTask.id, text: "live-batch", type: "text" },
      { taskId: deletedTask.id, text: "deleted-batch", type: "text" },
    ]);

    expect(events).toEqual([
      { taskId: liveTask.id, text: "live-single" },
      { taskId: deletedTask.id, text: "deleted-single" },
      { taskId: liveTask.id, text: "live-batch" },
      { taskId: deletedTask.id, text: "deleted-batch" },
    ]);
    await expect(store.getAgentLogs(liveTask.id)).resolves.toMatchObject([
      { text: "live-single" },
      { text: "live-batch" },
    ]);
    await expect(store.getAgentLogs(deletedTask.id)).resolves.toEqual([]);
  });
});
