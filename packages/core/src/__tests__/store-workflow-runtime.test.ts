import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SCHEMA_VERSION } from "../db.js";
import { TaskStore } from "../store.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-workflow-runtime-test-"));
}

describe("TaskStore workflow work items", () => {
  let rootDir: string;
  let globalDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = makeTmpDir();
    globalDir = join(rootDir, ".fusion-global");
    store = new TaskStore(rootDir, globalDir);
    await store.init();
  });

  afterEach(async () => {
    store.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function createTaskId(): Promise<string> {
    const task = await store.createTask({ description: "workflow work item test" });
    return task.id;
  }

  it("creates workflow work-item tables on fresh schema", () => {
    const db = store.getDatabase();
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workflow_work_items'")
      .get() as { name: string } | undefined;
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'workflow_work_items' ORDER BY name")
      .all() as Array<{ name: string }>;

    expect(table).toEqual({ name: "workflow_work_items" });
    expect(indexes.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "idx_workflow_work_items_due",
        "idx_workflow_work_items_leaseExpiresAt",
        "idx_workflow_work_items_task_run",
      ]),
    );
    expect(db.getSchemaVersion()).toBe(SCHEMA_VERSION);
  });

  it("upserts by run, task, node, and kind without duplicating work", async () => {
    const taskId = await createTaskId();

    const created = store.upsertWorkflowWorkItem({
      runId: "run-1",
      taskId,
      nodeId: "merge.node",
      kind: "merge",
      now: "2026-06-09T00:00:00.000Z",
    });
    const updated = store.upsertWorkflowWorkItem({
      runId: "run-1",
      taskId,
      nodeId: "merge.node",
      kind: "merge",
      state: "held",
      blockedReason: "shared branch is assembling",
      now: "2026-06-09T00:00:01.000Z",
    });

    expect(updated).toMatchObject({
      id: created.id,
      runId: "run-1",
      taskId,
      nodeId: "merge.node",
      kind: "merge",
      state: "held",
      attempt: 0,
      blockedReason: "shared branch is assembling",
    });

    const rows = store
      .getDatabase()
      .prepare("SELECT COUNT(*) AS count FROM workflow_work_items WHERE runId = ? AND taskId = ?")
      .get("run-1", taskId) as { count: number };
    expect(rows.count).toBe(1);
  });

  it("lists due runnable and retrying work independently of task column", async () => {
    const taskId = await createTaskId();
    await store.moveTask(taskId, "todo");
    await store.moveTask(taskId, "in-progress");
    await store.moveTask(taskId, "in-review");
    const now = "2026-06-09T00:00:00.000Z";

    const runnable = store.upsertWorkflowWorkItem({
      runId: "run-1",
      taskId,
      nodeId: "plan.node",
      kind: "task",
      state: "runnable",
      now,
    });
    const futureRetry = store.upsertWorkflowWorkItem({
      runId: "run-1",
      taskId,
      nodeId: "retry.node",
      kind: "retry",
      state: "retrying",
      retryAfter: "2026-06-09T00:05:00.000Z",
      now,
    });
    store.upsertWorkflowWorkItem({
      runId: "run-1",
      taskId,
      nodeId: "hold.node",
      kind: "manual-hold",
      state: "held",
      now,
    });

    expect(store.listDueWorkflowWorkItems({ now }).map((item) => item.id)).toEqual([runnable.id]);
    expect(store.listDueWorkflowWorkItems({ now: "2026-06-09T00:05:00.000Z" }).map((item) => item.id)).toEqual([
      runnable.id,
      futureRetry.id,
    ]);
  });

  it("acquires due leases and exposes expired running leases for reclaim", async () => {
    const taskId = await createTaskId();
    const item = store.upsertWorkflowWorkItem({
      runId: "run-lease",
      taskId,
      nodeId: "merge.node",
      kind: "merge",
      state: "runnable",
      now: "2026-06-09T00:00:00.000Z",
    });

    const leased = store.acquireWorkflowWorkItemLease(item.id, "worker-a", {
      now: "2026-06-09T00:00:00.000Z",
      leaseDurationMs: 60_000,
    });
    expect(leased).toMatchObject({
      id: item.id,
      state: "running",
      leaseOwner: "worker-a",
      leaseExpiresAt: "2026-06-09T00:01:00.000Z",
    });

    expect(
      store.acquireWorkflowWorkItemLease(item.id, "worker-b", {
        now: "2026-06-09T00:00:30.000Z",
        leaseDurationMs: 60_000,
      }),
    ).toBeNull();
    expect(store.listDueWorkflowWorkItems({ now: "2026-06-09T00:00:30.000Z" })).toEqual([]);

    expect(store.listDueWorkflowWorkItems({ now: "2026-06-09T00:01:00.000Z" }).map((due) => due.id)).toEqual([item.id]);
    const reclaimed = store.acquireWorkflowWorkItemLease(item.id, "worker-b", {
      now: "2026-06-09T00:01:00.000Z",
      leaseDurationMs: 60_000,
    });
    expect(reclaimed).toMatchObject({
      id: item.id,
      state: "running",
      leaseOwner: "worker-b",
      leaseExpiresAt: "2026-06-09T00:02:00.000Z",
    });
  });

  it("honors due-list state filters and validates lease duration", async () => {
    const taskId = await createTaskId();
    const item = store.upsertWorkflowWorkItem({
      runId: "run-filter",
      taskId,
      nodeId: "merge.node",
      kind: "merge",
      state: "runnable",
      now: "2026-06-09T00:00:00.000Z",
    });
    store.acquireWorkflowWorkItemLease(item.id, "worker-a", {
      now: "2026-06-09T00:00:00.000Z",
      leaseDurationMs: 60_000,
    });

    expect(store.listDueWorkflowWorkItems({ now: "2026-06-09T00:01:00.000Z", states: ["runnable"] })).toEqual([]);
    expect(store.listDueWorkflowWorkItems({ now: "2026-06-09T00:01:00.000Z", states: ["running"] }).map((due) => due.id)).toEqual([
      item.id,
    ]);
    expect(() =>
      store.acquireWorkflowWorkItemLease(item.id, "worker-b", {
        now: "2026-06-09T00:01:00.000Z",
        leaseDurationMs: 0,
      }),
    ).toThrow("workflow work item leaseDurationMs must be > 0 (received 0)");
  });

  it("preserves lease and retry metadata on idempotent duplicate upserts", async () => {
    const taskId = await createTaskId();
    const item = store.upsertWorkflowWorkItem({
      runId: "run-idempotent",
      taskId,
      nodeId: "retry.node",
      kind: "retry",
      state: "retrying",
      retryAfter: "2026-06-09T00:05:00.000Z",
      leaseOwner: "worker-a",
      leaseExpiresAt: "2026-06-09T00:06:00.000Z",
      lastError: "temporary failure",
      now: "2026-06-09T00:00:00.000Z",
    });

    const duplicate = store.upsertWorkflowWorkItem({
      runId: "run-idempotent",
      taskId,
      nodeId: "retry.node",
      kind: "retry",
      now: "2026-06-09T00:01:00.000Z",
    });

    expect(duplicate).toMatchObject({
      id: item.id,
      state: "retrying",
      retryAfter: "2026-06-09T00:05:00.000Z",
      leaseOwner: "worker-a",
      leaseExpiresAt: "2026-06-09T00:06:00.000Z",
      lastError: "temporary failure",
      updatedAt: "2026-06-09T00:01:00.000Z",
    });
  });

  it("does not requeue terminal work", async () => {
    const taskId = await createTaskId();
    const item = store.upsertWorkflowWorkItem({
      runId: "run-terminal",
      taskId,
      nodeId: "merge.node",
      kind: "merge",
      state: "runnable",
    });

    store.transitionWorkflowWorkItem(item.id, "succeeded", { now: "2026-06-09T00:00:01.000Z" });

    expect(() =>
      store.upsertWorkflowWorkItem({
        runId: "run-terminal",
        taskId,
        nodeId: "merge.node",
        kind: "merge",
        state: "runnable",
      }),
    ).toThrow(/terminal \(succeeded\) and cannot be requeued as runnable/);
  });
});
