import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { countAgentLogEntries, getAgentLogFilePath } from "../agent-log-file-store.js";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";

describe("TaskStore soft-delete agent log clearing (FN-5143)", () => {
  const harness = createTaskStoreTestHarness();

  const taskDir = (taskId: string) => join(harness.rootDir(), ".fusion", "tasks", taskId);

  beforeEach(async () => {
    await harness.beforeEach();
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  it("hides pre-existing persisted agent logs on soft-delete while preserving the file", async () => {
    const store = harness.store();
    const task = await harness.createTestTask();

    await store.appendAgentLog(task.id, "entry-1", "text");
    await store.appendAgentLog(task.id, "entry-2", "text");
    await store.appendAgentLog(task.id, "entry-3", "text");
    await store.getAgentLogs(task.id);

    expect(countAgentLogEntries(taskDir(task.id))).toBe(3);

    await store.deleteTask(task.id);

    expect(existsSync(getAgentLogFilePath(taskDir(task.id)))).toBe(true);
    expect(countAgentLogEntries(taskDir(task.id))).toBe(3);
    await expect(store.getAgentLogs(task.id)).resolves.toEqual([]);
    await expect(store.getAgentLogCount(task.id)).resolves.toBe(0);
    await expect(
      store.getAgentLogsByTimeRange(task.id, "2000-01-01T00:00:00.000Z", null),
    ).resolves.toEqual([]);
  });

  it("flushes buffered entries before soft-delete, then hides them while preserving the file", async () => {
    const store = harness.store();
    const task = await harness.createTestTask();

    await store.appendAgentLog(task.id, "buffered-only", "text");
    await store.deleteTask(task.id);

    expect(countAgentLogEntries(taskDir(task.id))).toBe(1);
    await expect(store.getAgentLogs(task.id)).resolves.toEqual([]);
  });

  it("keeps idempotent re-delete as a no-op for agent logs", async () => {
    const store = harness.store();
    const task = await harness.createTestTask();

    await store.appendAgentLog(task.id, "first", "text");
    await store.getAgentLogs(task.id);
    await store.deleteTask(task.id);

    expect(countAgentLogEntries(taskDir(task.id))).toBe(1);

    const rowBefore = (store as any).db
      .prepare('SELECT deletedAt, updatedAt, "column" FROM tasks WHERE id = ?')
      .get(task.id) as { deletedAt: string | null; updatedAt: string | null; column: string | null };

    await expect(store.deleteTask(task.id)).resolves.toMatchObject({ id: task.id });

    const rowAfter = (store as any).db
      .prepare('SELECT deletedAt, updatedAt, "column" FROM tasks WHERE id = ?')
      .get(task.id) as { deletedAt: string | null; updatedAt: string | null; column: string | null };
    expect(rowAfter.deletedAt).toBe(rowBefore.deletedAt);
    expect(rowAfter.updatedAt).toBe(rowBefore.updatedAt);
    expect(rowAfter.column).toBe("archived");
    expect(countAgentLogEntries(taskDir(task.id))).toBe(1);
  });

  it("clears only the soft-deleted parent logs when removing lineage references", async () => {
    const store = harness.store();
    const parent = await store.createTask({ description: "parent" });
    const child = await store.createTask({ description: "child", sourceTaskId: parent.id, sourceParentTaskId: parent.id });

    await store.appendAgentLog(parent.id, "parent-log", "text");
    await store.appendAgentLog(child.id, "child-log", "text");
    await store.getAgentLogs(parent.id);
    await store.getAgentLogs(child.id);

    expect(countAgentLogEntries(taskDir(child.id))).toBe(1);

    await store.deleteTask(parent.id, { removeLineageReferences: true });

    expect(countAgentLogEntries(taskDir(parent.id))).toBe(1);
    expect(countAgentLogEntries(taskDir(child.id))).toBe(1);
    await expect(store.getAgentLogs(parent.id)).resolves.toEqual([]);
    await expect(store.getAgentLogs(child.id)).resolves.toMatchObject([{ text: "child-log" }]);
  });

  it("does not affect other tasks' agent logs", async () => {
    const store = harness.store();
    const first = await harness.createTestTask();
    const second = await harness.createTestTask();

    await store.appendAgentLog(first.id, "first-log", "text");
    await store.appendAgentLog(second.id, "second-log", "text");
    await store.getAgentLogs(first.id);
    await store.getAgentLogs(second.id);

    await store.deleteTask(first.id);

    expect(countAgentLogEntries(taskDir(first.id))).toBe(1);
    expect(countAgentLogEntries(taskDir(second.id))).toBe(1);
    await expect(store.getAgentLogs(first.id)).resolves.toEqual([]);
    await expect(store.getAgentLogs(second.id)).resolves.toMatchObject([{ text: "second-log" }]);
  });

  it("emits task:deleted only after read APIs hide persisted agent logs", async () => {
    const store = harness.store();
    const task = await harness.createTestTask();
    await store.appendAgentLog(task.id, "event-order", "text");
    await store.getAgentLogs(task.id);

    const seenCounts: number[] = [];
    store.once("task:deleted", async (deletedTask) => {
      seenCounts.push(await store.getAgentLogCount(deletedTask.id));
    });

    await store.deleteTask(task.id);
    expect(seenCounts).toEqual([0]);
  });
});
