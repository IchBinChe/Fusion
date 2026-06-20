import { mkdtempSync } from "node:fs";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TaskStore } from "../store.js";
import type { Task } from "../types.js";

async function rewriteTaskJson(rootDir: string, task: Task): Promise<void> {
  const dir = join(rootDir, ".fusion", "tasks", task.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "task.json"), JSON.stringify(task), "utf-8");
}

describe("TaskStore orphaned task-dir reconciliation", () => {
  let rootDir: string;
  let globalDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "fusion-orphaned-task-dir-"));
    globalDir = mkdtempSync(join(tmpdir(), "fusion-orphaned-task-dir-global-"));
    store = new TaskStore(rootDir, globalDir);
    await store.init();
  });

  afterEach(async () => {
    store.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await rm(globalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function createDiskOnlyTask(id: string, patch: Partial<Task> = {}): Promise<Task> {
    const task = await store.createTaskWithReservedId(
      { description: `Disk-only ${id}`, column: "triage" },
      { taskId: id, applyDefaultWorkflowSteps: false, invokeTaskCreatedHook: false },
    );
    const diskTask: Task = { ...task, status: "planning", ...patch };
    await rewriteTaskJson(rootDir, diskTask);
    (store as any).db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    (store as any).db.bumpLastModified();
    return diskTask;
  }

  it("re-imports a valid task.json with no DB row so getTask and listTasks agree", async () => {
    const orphan = await createDiskOnlyTask("FN-9101", {
      dependencies: ["FN-1"],
      steps: [{ name: "Preflight", status: "pending" }],
    });

    expect((await store.listTasks({ includeArchived: false })).some((task) => task.id === orphan.id)).toBe(false);
    await expect(store.getTask(orphan.id)).rejects.toThrow("Task FN-9101 not found");

    const result = await store.reconcileOrphanedTaskDirs();

    expect(result.recovered).toEqual([orphan.id]);
    const detail = await store.getTask(orphan.id);
    expect(detail.id).toBe(orphan.id);
    expect(detail.column).toBe("triage");
    expect(detail.status).toBe("planning");
    expect(detail.dependencies).toEqual(["FN-1"]);
    expect((await store.listTasks({ includeArchived: false })).map((task) => task.id)).toContain(orphan.id);
    expect(store.getRunAuditEvents({ taskId: orphan.id, mutationType: "task:reconcile-orphaned-task-dir" })).toHaveLength(1);
  });

  it("re-imports orphaned task dirs during disk-backed store open", async () => {
    const orphan = await createDiskOnlyTask("FN-9102");

    store.close();
    store = new TaskStore(rootDir, globalDir);
    await store.init();

    expect((await store.getTask(orphan.id)).status).toBe("planning");
    expect((await store.listTasks({ includeArchived: false })).map((task) => task.id)).toContain(orphan.id);
  });

  it("does not overwrite an already-present DB row", async () => {
    const task = await store.createTaskWithReservedId(
      { description: "Authoritative DB row", title: "Original title" },
      { taskId: "FN-9103", applyDefaultWorkflowSteps: false, invokeTaskCreatedHook: false },
    );
    await rewriteTaskJson(rootDir, { ...task, title: "Disk drift title", description: "Disk drift" });

    const result = await store.reconcileOrphanedTaskDirs();

    expect(result.recovered).not.toContain(task.id);
    const detail = await store.getTask(task.id);
    expect(detail.title).toBe("Original title");
    expect(detail.description).toBe("Authoritative DB row");
  });

  it("skips soft-deleted and tombstoned task IDs without resurrection", async () => {
    const task = await store.createTaskWithReservedId(
      { description: "Delete me" },
      { taskId: "FN-9104", applyDefaultWorkflowSteps: false, invokeTaskCreatedHook: false },
    );
    await store.deleteTask(task.id);

    const result = await store.reconcileOrphanedTaskDirs();

    expect(result.recovered).not.toContain(task.id);
    expect((await store.listTasks({ includeArchived: true })).map((candidate) => candidate.id)).not.toContain(task.id);
    await expect(store.getTask(task.id)).rejects.toThrow("Task FN-9104 not found");
    expect(await store.getTask(task.id, { includeDeleted: true })).toMatchObject({ id: task.id, deletedAt: expect.any(String) });
  });

  it("skips archived IDs that still have or regain a task.json", async () => {
    const task = await store.createTaskWithReservedId(
      { description: "Archive me" },
      { taskId: "FN-9105", applyDefaultWorkflowSteps: false, invokeTaskCreatedHook: false },
    );
    await store.archiveTask(task.id, true);
    await rewriteTaskJson(rootDir, { ...task, column: "triage", status: "planning" });

    const result = await store.reconcileOrphanedTaskDirs();

    expect(result.recovered).not.toContain(task.id);
    expect((await store.listTasks({ includeArchived: false })).map((candidate) => candidate.id)).not.toContain(task.id);
    expect((await store.listTasks({ includeArchived: true })).map((candidate) => candidate.id)).toContain(task.id);
    expect((await store.getTask(task.id)).column).toBe("archived");
  });

  it("skips a stale orphan task dir beyond the recency window (no resurrection of old deleted tasks)", async () => {
    // Regression: legacy hard-deletes left no tombstone, so an ancient task.json lingering
    // on disk was silently re-imported onto the live board ("all task IDs reset" failure).
    // A live task must exist so the recency window applies (an empty DB bypasses it — see
    // the corruption-recovery tests below).
    await store.createTaskWithReservedId(
      { description: "Keeps the board non-empty" },
      { taskId: "FN-9200", applyDefaultWorkflowSteps: false, invokeTaskCreatedHook: false },
    );
    const orphan = await createDiskOnlyTask("FN-9110");
    // Backdate the task.json well beyond the 7-day recency window.
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const taskJsonPath = join(rootDir, ".fusion", "tasks", orphan.id, "task.json");
    await utimes(taskJsonPath, eightDaysAgo, eightDaysAgo);

    const result = await store.reconcileOrphanedTaskDirs();

    expect(result.recovered).not.toContain(orphan.id);
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: orphan.id, reason: "stale-orphan-dir-beyond-recency-window" }),
    ]));
    await expect(store.getTask(orphan.id)).rejects.toThrow("Task FN-9110 not found");
  });

  it("recovers a stale orphan dir just inside the recency window (boundary)", async () => {
    await store.createTaskWithReservedId(
      { description: "Keeps the board non-empty" },
      { taskId: "FN-9201", applyDefaultWorkflowSteps: false, invokeTaskCreatedHook: false },
    );
    const orphan = await createDiskOnlyTask("FN-9111");
    // ~6 days old — comfortably inside the 7-day window.
    const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
    const taskJsonPath = join(rootDir, ".fusion", "tasks", orphan.id, "task.json");
    await utimes(taskJsonPath, sixDaysAgo, sixDaysAgo);

    const result = await store.reconcileOrphanedTaskDirs();

    expect(result.recovered).toContain(orphan.id);
  });

  it("bypasses the recency window when the live task table is empty (corruption / restore recovery)", async () => {
    // Restore-from-old-backup: surviving task.json files keep their original (old) mtimes and
    // the DB has no live rows. The recency gate must NOT strand them — that is the exact
    // recovery the sweep exists for.
    const orphan = await createDiskOnlyTask("FN-9112");
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const taskJsonPath = join(rootDir, ".fusion", "tasks", orphan.id, "task.json");
    await utimes(taskJsonPath, thirtyDaysAgo, thirtyDaysAgo);

    const result = await store.reconcileOrphanedTaskDirs();

    expect(result.recovered).toContain(orphan.id);
  });

  it("bypasses the recency window when the caller forces it (ignoreRecencyWindow)", async () => {
    await store.createTaskWithReservedId(
      { description: "Keeps the board non-empty" },
      { taskId: "FN-9202", applyDefaultWorkflowSteps: false, invokeTaskCreatedHook: false },
    );
    const orphan = await createDiskOnlyTask("FN-9113");
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const taskJsonPath = join(rootDir, ".fusion", "tasks", orphan.id, "task.json");
    await utimes(taskJsonPath, thirtyDaysAgo, thirtyDaysAgo);

    const result = await store.reconcileOrphanedTaskDirs({ ignoreRecencyWindow: true });

    expect(result.recovered).toContain(orphan.id);
  });

  it("skips malformed task.json and directories without task.json without throwing", async () => {
    const malformedDir = join(rootDir, ".fusion", "tasks", "FN-9106");
    await mkdir(malformedDir, { recursive: true });
    await writeFile(join(malformedDir, "task.json"), "{ nope", "utf-8");
    await mkdir(join(rootDir, ".fusion", "tasks", "FN-9107"), { recursive: true });

    const result = await store.reconcileOrphanedTaskDirs();

    expect(result.recovered).toEqual([]);
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "FN-9106", reason: expect.stringContaining("malformed-task-json") }),
      { id: "FN-9107", reason: "missing-task-json" },
    ]));
  });

  it("reports malformed live task metadata without overwriting the DB row", async () => {
    const task = await store.createTaskWithReservedId(
      { description: "Malformed file but valid DB" },
      { taskId: "FN-9108", applyDefaultWorkflowSteps: false, invokeTaskCreatedHook: false },
    );
    await rewriteTaskJson(rootDir, { ...task, createdAt: "riage-FN-6750-1781908063" });

    const result = await store.reconcileOrphanedTaskDirs();

    expect(result.recovered).not.toContain(task.id);
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: task.id, reason: expect.stringContaining("malformed-task-metadata") }),
    ]));
    expect((await store.getTask(task.id)).createdAt).toBe(task.createdAt);
  });

  it("is a safe no-op for in-memory stores even if task dirs exist", async () => {
    store.close();
    store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await store.init();
    const now = new Date().toISOString();
    await rewriteTaskJson(rootDir, {
      id: "FN-9109",
      description: "Ignored in-memory orphan",
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: now,
      updatedAt: now,
      columnMovedAt: now,
      status: "planning",
    });

    const result = await store.reconcileOrphanedTaskDirs();

    expect(result).toEqual({ recovered: [], skipped: [] });
    expect((await store.listTasks({ includeArchived: false })).map((task) => task.id)).not.toContain("FN-9109");
  });
});
