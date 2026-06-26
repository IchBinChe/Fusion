import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSharedTaskStoreTestHarness } from "./store-test-helpers.js";

describe("createSharedTaskStoreTestHarness", () => {
  const harness = createSharedTaskStoreTestHarness();

  beforeAll(harness.beforeAll);
  beforeEach(harness.beforeEach);
  afterEach(harness.afterEach);
  afterAll(harness.afterAll);

  it("resets ids so tasks restart from FN-001", async () => {
    const task = await harness.store().createTask({ description: "first" });
    expect(task.id).toBe("FN-001");
  });

  it("workflow steps listing is empty between tests (U7c: plugin-only, table dropped)", async () => {
    const steps = await harness.store().listWorkflowSteps();
    expect(steps).toEqual([]);
  });

  it("seeds state across multiple tables for truncation coverage", async () => {
    const store = harness.store();
    const task = await store.createTask({ description: "seed" });
    const db = (store as any).db;
    db.prepare(
      `INSERT INTO agents (id, name, role, state, createdAt, updatedAt, metadata, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "agent-1",
      "Seed Agent",
      "executor",
      "idle",
      new Date().toISOString(),
      new Date().toISOString(),
      "{}",
      "{}",
    );
    db.prepare(
      `INSERT INTO automations (id, name, scheduleType, cronExpression, command, enabled, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "auto-1",
      "Seed Automation",
      "cron",
      "* * * * *",
      "echo ok",
      1,
      new Date().toISOString(),
      new Date().toISOString(),
    );
    db.prepare(
      "INSERT INTO missions (id, title, status, interviewState, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "M-001",
      "Seed Mission",
      "active",
      "complete",
      new Date().toISOString(),
      new Date().toISOString(),
    );
    await store.updateSettings({ maxConcurrent: 7 });
    harness.insertLogEntryWithTimestamp(task.id, "log", "info", new Date().toISOString());

    const dir = join(harness.rootDir(), ".fusion", "tasks", task.id);
    expect(existsSync(dir)).toBe(true);
  });

  it("starts next test from empty tables and scrubbed task directory", async () => {
    const store = harness.store();

    expect(await store.listTasks()).toEqual([]);
    expect(await store.listWorkflowSteps()).toEqual([]);
    const db = (store as any).db;
    expect((db.prepare("SELECT COUNT(*) as count FROM automations").get() as { count: number }).count).toBe(0);
    expect((db.prepare("SELECT COUNT(*) as count FROM agents").get() as { count: number }).count).toBe(0);
    expect((db.prepare("SELECT COUNT(*) as count FROM missions").get() as { count: number }).count).toBe(0);
    expect((await store.getSettings()).maxConcurrent).toBe(2);

    const tasksDir = join(harness.rootDir(), ".fusion", "tasks");
    expect(await readdir(tasksDir)).toEqual([]);
  });

  it("useIsolatedStore is scoped to the current test only", async () => {
    await harness.useIsolatedStore();
    const task = await harness.store().createTask({ description: "isolated" });
    expect(task.id).toBe("FN-001");
  });

  it("restores shared store after isolated usage", async () => {
    const task = await harness.store().createTask({ description: "shared-again" });
    expect(task.id).toBe("FN-001");
  });
});
