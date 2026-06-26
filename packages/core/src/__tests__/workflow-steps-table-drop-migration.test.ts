import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SCHEMA_VERSION } from "../db.js";
import { CODE_REVIEW_GROUP_ID } from "../builtin-code-review-group.js";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";

/*
FNXC:WorkflowStepCRUD 2026-06-26-14:00:
U7c cutover (migration 131) DROPs the legacy `workflow_steps` table. Pre/post-merge
workflow steps run graph-native and record into task.workflowStepResults; nothing reads
`workflow_steps` rows at runtime. Migration 130 already normalized legacy compiled-step
enable ids (WS-xxx) in tasks.enabledWorkflowSteps to their built-in optional-group node ids,
so the table holds nothing read at runtime by the time 131 drops it.

This seed-at-130 test seeds a DB at exactly schemaVersion 130 (the version right before the
cutover) with a populated `workflow_steps` table AND a task whose enabledWorkflowSteps already
holds the normalized graph node id (`code-review`). It then opens the store (replaying ONLY
migration 131) and asserts:
  (a) the legacy table is gone — querying it throws and it is absent from sqlite_master; and
  (b) the task is intact and still resolves/runs its graph optional-group — its normalized
      enable id survives and its workflow selection resolves.
*/

describe("Migration 131: drop the legacy workflow_steps table (U7c cutover)", () => {
  const harness = createTaskStoreTestHarness();

  beforeEach(async () => {
    await harness.beforeEach();
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  it("drops a populated workflow_steps table at v130→131 and leaves the task's normalized graph enable id intact", async () => {
    await harness.reopenDiskBackedStore();
    const store = harness.store();
    const task = await harness.createTestTask();
    const db = store.getDatabase();

    // Seed a realistic legacy `workflow_steps` table (as a real <131 DB would carry) with a
    // row, then a task whose enabledWorkflowSteps already holds the normalized node id.
    db.prepare(
      `CREATE TABLE IF NOT EXISTS workflow_steps (
         id TEXT PRIMARY KEY, templateId TEXT, name TEXT NOT NULL, description TEXT NOT NULL,
         mode TEXT NOT NULL DEFAULT 'prompt', phase TEXT NOT NULL DEFAULT 'pre-merge',
         prompt TEXT NOT NULL DEFAULT '', gateMode TEXT NOT NULL DEFAULT 'advisory',
         toolMode TEXT, scriptName TEXT, enabled INTEGER NOT NULL DEFAULT 1, defaultOn INTEGER DEFAULT 0,
         modelProvider TEXT, modelId TEXT, migrated_fragment_id TEXT,
         createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
       )`,
    ).run();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT OR REPLACE INTO workflow_steps
         (id, templateId, name, description, mode, phase, prompt, gateMode, enabled, defaultOn, createdAt, updatedAt)
       VALUES ('WS-001', ?, 'Code Review', 'desc', 'prompt', 'pre-merge', 'x', 'advisory', 1, 1, ?, ?)`,
    ).run(CODE_REVIEW_GROUP_ID, now, now);

    db.prepare("UPDATE tasks SET enabledWorkflowSteps = ? WHERE id = ?").run(
      JSON.stringify([CODE_REVIEW_GROUP_ID]),
      task.id,
    );

    // Stamp the DB at v130 (right before the cutover) so opening it replays ONLY migration 131.
    db.prepare("UPDATE __meta SET value = '130' WHERE key = 'schemaVersion'").run();

    await harness.reopenDiskBackedStore();
    const migratedStore = harness.store();
    const migratedDb = migratedStore.getDatabase();

    // (a) The cutover dropped the table.
    expect(migratedDb.getSchemaVersion()).toBe(SCHEMA_VERSION);
    expect(
      migratedDb
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workflow_steps'")
        .get(),
    ).toBeUndefined();
    // Querying the dropped table now throws (nothing is stranded reading it).
    expect(() => migratedDb.prepare("SELECT 1 FROM workflow_steps").get()).toThrow();

    // (b) The task survives and still resolves/runs its graph optional-group: its normalized
    // enable id is intact, so the executor's `enabledWorkflowSteps.includes(node.id)` toggle
    // still enables the `code-review` optional-group node.
    const migratedTask = await migratedStore.getTask(task.id);
    expect(migratedTask.enabledWorkflowSteps).toEqual([CODE_REVIEW_GROUP_ID]);
  });
});
