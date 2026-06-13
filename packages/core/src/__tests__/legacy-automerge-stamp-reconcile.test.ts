import { afterEach, describe, expect, it } from "vitest";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TaskStore } from "../store.js";
import { allowsAutoMergeProcessing } from "../task-merge.js";
import type { Task } from "../types.js";
import { createTaskStoreTestHarness, makeTmpDir } from "./store-test-helpers.js";

async function moveToReview(store: TaskStore, description: string): Promise<Task> {
  const task = await store.createTask({ description });
  await store.moveTask(task.id, "todo");
  await store.moveTask(task.id, "in-progress");
  return store.moveTask(task.id, "in-review");
}

async function seedLegacyStamp(store: TaskStore, rootDir: string, description = "legacy stamp"): Promise<Task> {
  const task = await moveToReview(store, description);
  (store as any).db.prepare("UPDATE tasks SET autoMerge = 1, autoMergeProvenance = NULL WHERE id = ?").run(task.id);
  const taskJsonPath = join(rootDir, ".fusion", "tasks", task.id, "task.json");
  const diskTask = JSON.parse(await readFile(taskJsonPath, "utf-8")) as Task;
  diskTask.autoMerge = true;
  delete diskTask.autoMergeProvenance;
  await writeFile(taskJsonPath, JSON.stringify(diskTask, null, 2));
  return (await store.getTask(task.id))!;
}

async function resetLegacyMarker(store: TaskStore): Promise<void> {
  (store as any).db.prepare("DELETE FROM __meta WHERE key = 'legacyAutoMergeStampMarkedVersion'").run();
}

describe("legacy auto-merge stamp reconciliation", () => {
  const harness = createTaskStoreTestHarness();
  let rootDir: string;
  let store: TaskStore;

  afterEach(async () => {
    await harness.afterEach();
  });

  async function setupHarness(): Promise<void> {
    await harness.beforeEach();
    rootDir = harness.rootDir();
    store = harness.store();
  }

  it("marks ambiguous legacy in-review stamps once without changing autoMerge", async () => {
    await setupHarness();
    const legacy = await seedLegacyStamp(store, rootDir);
    const user = await moveToReview(store, "user override");
    await store.updateTask(user.id, { autoMerge: true });
    await resetLegacyMarker(store);

    await (store as any).markLegacyAutoMergeStampsOnce();

    const marked = await store.getTask(legacy.id);
    const preserved = await store.getTask(user.id);
    expect(marked?.autoMerge).toBe(true);
    expect(marked?.autoMergeProvenance).toBe("legacy-stamp");
    expect(preserved?.autoMerge).toBe(true);
    expect(preserved?.autoMergeProvenance).toBe("user");

    const firstAuditCount = store.getRunAuditEvents({ mutationType: "task:auto-merge-legacy-stamp-marked" }).length;
    await (store as any).markLegacyAutoMergeStampsOnce();
    expect(store.getRunAuditEvents({ mutationType: "task:auto-merge-legacy-stamp-marked" })).toHaveLength(firstAuditCount);
  });

  it("no-ops on empty and zero-candidate databases while setting the once marker", async () => {
    await setupHarness();
    await resetLegacyMarker(store);

    await (store as any).markLegacyAutoMergeStampsOnce();

    expect(store.getRunAuditEvents({ mutationType: "task:auto-merge-legacy-stamp-marked" })).toHaveLength(0);
    const regular = await moveToReview(store, "no override");
    expect(regular.autoMerge).toBeUndefined();
    await (store as any).markLegacyAutoMergeStampsOnce();
    expect((await store.getTask(regular.id))?.autoMergeProvenance).toBeUndefined();
  });

  it("dry-runs candidates without mutating and apply clears only legacy stamps", async () => {
    await setupHarness();
    const legacy = await seedLegacyStamp(store, rootDir);
    await resetLegacyMarker(store);
    await (store as any).markLegacyAutoMergeStampsOnce();

    const user = await moveToReview(store, "genuine user true");
    await store.updateTask(user.id, { autoMerge: true });

    const dryRun = await store.reconcileLegacyAutoMergeStamps();
    expect(dryRun).toEqual([{ taskId: legacy.id, column: "in-review", cleared: false }]);
    expect((await store.getTask(legacy.id))?.autoMerge).toBe(true);
    expect((await store.getTask(legacy.id))?.autoMergeProvenance).toBe("legacy-stamp");

    // Original symptom: with global autoMerge off, the legacy value still passes the gate.
    expect(allowsAutoMergeProcessing((await store.getTask(legacy.id))!, { autoMerge: false })).toBe(true);

    const applied = await store.reconcileLegacyAutoMergeStamps({ apply: true });
    expect(applied).toEqual([{ taskId: legacy.id, column: "in-review", cleared: true }]);

    const cleared = (await store.getTask(legacy.id))!;
    expect(cleared.autoMerge).toBeUndefined();
    expect(cleared.autoMergeProvenance).toBeUndefined();
    expect(allowsAutoMergeProcessing(cleared, { autoMerge: false })).toBe(false);

    const preserved = (await store.getTask(user.id))!;
    expect(preserved.autoMerge).toBe(true);
    expect(preserved.autoMergeProvenance).toBe("user");
    expect(allowsAutoMergeProcessing(preserved, { autoMerge: false })).toBe(true);

    const clearAudits = store.getRunAuditEvents({ mutationType: "task:auto-merge-legacy-stamp-cleared" });
    expect(clearAudits).toHaveLength(1);
    expect(clearAudits[0]?.target).toBe(legacy.id);
  });

  it("round-trips provenance through SQLite and task.json, including absent provenance", async () => {
    const diskRoot = makeTmpDir();
    const globalDir = makeTmpDir();
    let diskStore = new TaskStore(diskRoot, globalDir);
    await diskStore.init();
    try {
      const inherited = await moveToReview(diskStore, "absent provenance");
      const explicit = await moveToReview(diskStore, "explicit provenance");
      await diskStore.updateTask(explicit.id, { autoMerge: true });

      const explicitJson = JSON.parse(await readFile(join(diskRoot, ".fusion", "tasks", explicit.id, "task.json"), "utf-8")) as Task;
      const inheritedJson = JSON.parse(await readFile(join(diskRoot, ".fusion", "tasks", inherited.id, "task.json"), "utf-8")) as Task;
      expect(explicitJson.autoMergeProvenance).toBe("user");
      expect(inheritedJson.autoMergeProvenance).toBeUndefined();

      diskStore.close();
      diskStore = new TaskStore(diskRoot, globalDir);
      await diskStore.init();

      expect((await diskStore.getTask(explicit.id))?.autoMergeProvenance).toBe("user");
      expect((await diskStore.getTask(explicit.id, { activityLogLimit: 50 }))?.autoMergeProvenance).toBe("user");
      expect((await diskStore.getTask(inherited.id))?.autoMergeProvenance).toBeUndefined();
      expect((await diskStore.getTask(inherited.id, { activityLogLimit: 50 }))?.autoMergeProvenance).toBeUndefined();
    } finally {
      diskStore.close();
      await rm(diskRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await rm(globalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
