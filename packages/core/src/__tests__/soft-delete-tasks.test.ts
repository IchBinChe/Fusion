import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";

describe("TaskStore soft delete", () => {
  const harness = createTaskStoreTestHarness();

  beforeEach(async () => {
    await harness.beforeEach();
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  it("soft-deletes rows, keeps task directory, and emits task:deleted", async () => {
    const store = harness.store();
    const task = await harness.createTestTask();
    const taskDir = join(harness.rootDir(), ".fusion", "tasks", task.id);

    const deletedEvents: string[] = [];
    store.on("task:deleted", (event) => deletedEvents.push(event.id));

    await store.deleteTask(task.id);

    await expect(store.getTask(task.id)).rejects.toThrow(`Task ${task.id} not found`);
    const row = (store as any).db.prepare("SELECT deletedAt FROM tasks WHERE id = ?").get(task.id) as { deletedAt: string | null };
    expect(typeof row.deletedAt).toBe("string");
    expect(existsSync(taskDir)).toBe(true);
    expect(deletedEvents).toContain(task.id);
  });

  it("excludes soft-deleted tasks from live readers and FTS search", async () => {
    const store = harness.store();
    const task = await store.createTask({ column: "todo", title: "Soft delete me", description: "keyword-needle description" });

    const before = await store.searchTasks("keyword-needle");
    expect(before.map((entry) => entry.id)).toContain(task.id);

    await store.deleteTask(task.id);

    const listed = await store.listTasks();
    expect(listed.map((entry) => entry.id)).not.toContain(task.id);

    const after = await store.searchTasks("keyword-needle");
    expect(after.map((entry) => entry.id)).not.toContain(task.id);
  });

  it("allows deleting parent after dependent is soft-deleted", async () => {
    const store = harness.store();
    const parent = await store.createTask({ column: "todo", title: "parent", description: "parent description" });
    const dependent = await store.createTask({ column: "todo", title: "dependent", description: "dependent description" });
    await store.updateTask(dependent.id, { dependencies: [parent.id] });

    await store.deleteTask(dependent.id);
    await expect(store.deleteTask(parent.id)).resolves.toMatchObject({ id: parent.id });
  });
});
