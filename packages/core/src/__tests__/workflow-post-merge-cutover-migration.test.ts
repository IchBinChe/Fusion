import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SCHEMA_VERSION } from "../db.js";
import { BROWSER_VERIFICATION_GROUP_ID } from "../builtin-browser-verification-group.js";
import { CODE_REVIEW_GROUP_ID } from "../builtin-code-review-group.js";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";

/*
FNXC:WorkflowPostMerge 2026-06-26-12:00:
Migration 130 (U7b post-merge graph-native cutover) — legacy enable-id normalization.
A task's enabledWorkflowSteps must reference GRAPH node ids so the graph enables the right
optional-group node now that the graph is the single post-merge owner. Legacy DBs may hold
compiled `workflow_steps` row ids (WS-xxx) whose templateId is a built-in optional-group node
id (browser-verification / code-review). This test seeds a DB at the old schema (129) with
exactly that legacy shape and asserts init() rewrites the WS-row id to the node id, de-dups,
leaves already-node-id and compiled-workflow entries untouched, and is idempotent across reopen.
*/

const WS_BV = "WS-TEST-BV"; // legacy compiled row for the browser-verification optional group
const WS_DOC = "WS-TEST-DOC"; // compiled-workflow materialization row (templateId workflow:*)

function insertWorkflowStep(
  db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } },
  args: { id: string; templateId: string; name: string; phase: string },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO workflow_steps
       (id, templateId, name, description, mode, phase, prompt, gateMode, toolMode, enabled, defaultOn, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, 'prompt', ?, 'x', 'advisory', 'coding', 1, 0, ?, ?)`,
  ).run(args.id, args.templateId, args.name, args.name, args.phase, now, now);
}

describe("Migration 130: post-merge cutover enable-id normalization", () => {
  const harness = createTaskStoreTestHarness();

  beforeEach(async () => {
    await harness.beforeEach();
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  it("rewrites legacy built-in optional-group WS ids to graph node ids, de-dups, and leaves node-id/compiled entries untouched", async () => {
    await harness.reopenDiskBackedStore();
    const store = harness.store();
    const task = await harness.createTestTask();
    const db = store.getDatabase();

    // Legacy compiled row for the browser-verification optional group, plus a compiled-workflow
    // materialization row (templateId workflow:*) that must NOT be rewritten.
    insertWorkflowStep(db as any, { id: WS_BV, templateId: BROWSER_VERIFICATION_GROUP_ID, name: "Browser Verification", phase: "pre-merge" });
    insertWorkflowStep(db as any, { id: WS_DOC, templateId: "workflow:builtin:compound-engineering", name: "Document learnings", phase: "post-merge" });

    // Legacy enable set: a WS-row id to rewrite, the SAME node id already present (dedup target),
    // an already-correct node id, and a compiled-workflow row id (left as-is).
    const legacyEnabled = [WS_BV, BROWSER_VERIFICATION_GROUP_ID, CODE_REVIEW_GROUP_ID, WS_DOC];
    db.prepare("UPDATE tasks SET enabledWorkflowSteps = ? WHERE id = ?").run(JSON.stringify(legacyEnabled), task.id);

    // Roll the DB back to the pre-migration schema so init() replays migration 130.
    db.prepare("UPDATE __meta SET value = '129' WHERE key = 'schemaVersion'").run();

    await harness.reopenDiskBackedStore();
    const migratedDb = harness.store().getDatabase();
    expect(migratedDb.getSchemaVersion()).toBe(SCHEMA_VERSION);

    const row = migratedDb.prepare("SELECT enabledWorkflowSteps FROM tasks WHERE id = ?").get(task.id) as { enabledWorkflowSteps: string };
    const enabled = JSON.parse(row.enabledWorkflowSteps) as string[];

    // WS_BV → browser-verification node id; duplicate browser-verification collapsed; code-review
    // kept; compiled-workflow row id (WS_DOC) left untouched. Order preserved.
    expect(enabled).toEqual([BROWSER_VERIFICATION_GROUP_ID, CODE_REVIEW_GROUP_ID, WS_DOC]);
    // No raw WS-row id for a built-in optional group survives.
    expect(enabled).not.toContain(WS_BV);
  });

  it("is idempotent: a second init() makes no further change", async () => {
    await harness.reopenDiskBackedStore();
    const store = harness.store();
    const task = await harness.createTestTask();
    const db = store.getDatabase();

    insertWorkflowStep(db as any, { id: WS_BV, templateId: BROWSER_VERIFICATION_GROUP_ID, name: "Browser Verification", phase: "pre-merge" });
    db.prepare("UPDATE tasks SET enabledWorkflowSteps = ? WHERE id = ?").run(JSON.stringify([WS_BV]), task.id);
    db.prepare("UPDATE __meta SET value = '129' WHERE key = 'schemaVersion'").run();

    await harness.reopenDiskBackedStore();
    const afterFirst = JSON.parse(
      (harness.store().getDatabase().prepare("SELECT enabledWorkflowSteps FROM tasks WHERE id = ?").get(task.id) as { enabledWorkflowSteps: string }).enabledWorkflowSteps,
    ) as string[];
    expect(afterFirst).toEqual([BROWSER_VERIFICATION_GROUP_ID]);

    // Reopen again (already at SCHEMA_VERSION → migration 130 does not re-run; value is stable).
    await harness.reopenDiskBackedStore();
    const afterSecond = JSON.parse(
      (harness.store().getDatabase().prepare("SELECT enabledWorkflowSteps FROM tasks WHERE id = ?").get(task.id) as { enabledWorkflowSteps: string }).enabledWorkflowSteps,
    ) as string[];
    expect(afterSecond).toEqual([BROWSER_VERIFICATION_GROUP_ID]);
  });
});
