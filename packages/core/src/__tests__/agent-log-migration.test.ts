import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { countAgentLogEntries, getAgentLogFilePath, readAgentLogEntries } from "../agent-log-file-store.js";
import { SCHEMA_VERSION } from "../db.js";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";

describe("Agent log migration: SQLite → JSONL", () => {
  const harness = createTaskStoreTestHarness();

  const taskDir = (taskId: string) => join(harness.rootDir(), ".fusion", "tasks", taskId);

  beforeEach(async () => {
    await harness.beforeEach();
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  it("migrates legacy agentLogEntries rows to per-task JSONL files and rewrites citations", async () => {
    await harness.reopenDiskBackedStore();
    const store = harness.store();
    const taskA = await harness.createTestTask();
    const taskB = await harness.createTestTask();
    const db = store.getDatabase();

    db.exec(`
      CREATE TABLE IF NOT EXISTS agentLogEntries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        taskId TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        text TEXT NOT NULL,
        type TEXT NOT NULL,
        detail TEXT,
        agent TEXT
      )
    `);

    const insertLegacyRow = db.prepare(`
      INSERT INTO agentLogEntries (taskId, timestamp, text, type, detail, agent)
      VALUES (?, ?, ?, ?, ?, ?)
      RETURNING id
    `);
    const legacyA1 = insertLegacyRow.get(taskA.id, "2026-06-02T00:00:01.000Z", "task-a-1 G-MIG001", "text", null, "executor") as { id: number };
    const legacyB1 = insertLegacyRow.get(taskB.id, "2026-06-02T00:00:02.000Z", "task-b-1", "tool", '{"tool":"scan"}', "reviewer") as { id: number };
    const legacyA2 = insertLegacyRow.get(taskA.id, "2026-06-02T00:00:03.000Z", "task-a-2 G-MIG001", "text", null, "executor") as { id: number };

    const insertCitation = db.prepare(`
      INSERT INTO goal_citations (goalId, agentId, taskId, surface, sourceRef, snippet, timestamp)
      VALUES (?, ?, ?, 'agent_log', ?, ?, ?)
    `);
    insertCitation.run("G-MIG001", "executor", taskA.id, `agentLog:${legacyA1.id}`, "task-a-1 G-MIG001", "2026-06-02T00:00:01.000Z");
    insertCitation.run("G-MIG001", "executor", taskA.id, `agentLog:${legacyA2.id}`, "task-a-2 G-MIG001", "2026-06-02T00:00:03.000Z");

    db.prepare("DELETE FROM __meta WHERE key = ?").run("agentLogEntriesToFileMigrationVersion");
    db.prepare("UPDATE __meta SET value = '101' WHERE key = 'schemaVersion'").run();

    expect(existsSync(getAgentLogFilePath(taskDir(taskA.id)))).toBe(false);
    expect(existsSync(getAgentLogFilePath(taskDir(taskB.id)))).toBe(false);

    await harness.reopenDiskBackedStore();

    const migratedStore = harness.store();
    const migratedDb = migratedStore.getDatabase();

    expect(migratedDb.getSchemaVersion()).toBe(SCHEMA_VERSION);
    const hasTable = migratedDb
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agentLogEntries' LIMIT 1")
      .get();
    expect(hasTable).toBeUndefined();

    expect(countAgentLogEntries(taskDir(taskA.id))).toBe(2);
    expect(countAgentLogEntries(taskDir(taskB.id))).toBe(1);
    expect(readAgentLogEntries(taskDir(taskA.id)).map((entry) => entry.text)).toEqual(["task-a-1 G-MIG001", "task-a-2 G-MIG001"]);
    expect(readAgentLogEntries(taskDir(taskB.id)).map((entry) => entry.text)).toEqual(["task-b-1"]);

    const citations = migratedStore.listGoalCitations({ goalId: "G-MIG001" });
    expect(new Set(citations.map((citation) => citation.sourceRef))).toEqual(
      new Set([`agentLog:${taskA.id}:1`, `agentLog:${taskA.id}:2`]),
    );
  });

  it("does not create agentLogEntries table on fresh init", async () => {
    const store = harness.store();
    const db = store.getDatabase();

    const hasTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agentLogEntries' LIMIT 1")
      .get();

    expect(hasTable).toBeUndefined();
  });

  it("sets the migration guard on fresh init", async () => {
    const store = harness.store();
    const db = store.getDatabase();
    const migrationRow = db
      .prepare("SELECT value FROM __meta WHERE key = ?")
      .get("agentLogEntriesToFileMigrationVersion") as { value: string } | undefined;

    expect(migrationRow?.value).toBe("1");
  });

  it("handles empty legacy agentLogEntries tables gracefully", async () => {
    await harness.reopenDiskBackedStore();
    const db = harness.store().getDatabase();

    db.exec(`
      CREATE TABLE IF NOT EXISTS agentLogEntries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        taskId TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        text TEXT NOT NULL,
        type TEXT NOT NULL,
        detail TEXT,
        agent TEXT
      )
    `);
    db.prepare("DELETE FROM __meta WHERE key = ?").run("agentLogEntriesToFileMigrationVersion");
    db.prepare("UPDATE __meta SET value = '101' WHERE key = 'schemaVersion'").run();

    await harness.reopenDiskBackedStore();

    const reopenedDb = harness.store().getDatabase();
    const migrationRow = reopenedDb
      .prepare("SELECT value FROM __meta WHERE key = ?")
      .get("agentLogEntriesToFileMigrationVersion") as { value: string } | undefined;
    const hasTable = reopenedDb
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agentLogEntries' LIMIT 1")
      .get();

    expect(migrationRow?.value).toBe("1");
    expect(reopenedDb.getSchemaVersion()).toBe(SCHEMA_VERSION);
    expect(hasTable).toBeUndefined();
  });

  it("keeps file-backed citation source-refs stable after rereads", async () => {
    const store = harness.store();
    const task = await harness.createTestTask();

    await store.appendAgentLog(task.id, "working on G-MIG001", "text", undefined, "executor");
    await store.getAgentLogs(task.id);

    const firstRead = store.listGoalCitations({ goalId: "G-MIG001" });
    await store.getAgentLogs(task.id, { limit: 10 });
    const secondRead = store.listGoalCitations({ goalId: "G-MIG001" });

    expect(firstRead).toHaveLength(1);
    expect(secondRead).toHaveLength(1);
    expect(firstRead[0]?.sourceRef).toBe(`agentLog:${task.id}:1`);
    expect(secondRead[0]?.sourceRef).toBe(firstRead[0]?.sourceRef);
  });

  it("drops the legacy table once and does not recreate it on later init", async () => {
    await harness.reopenDiskBackedStore();
    const db = harness.store().getDatabase();

    db.exec(`
      CREATE TABLE IF NOT EXISTS agentLogEntries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        taskId TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        text TEXT NOT NULL,
        type TEXT NOT NULL,
        detail TEXT,
        agent TEXT
      )
    `);
    db.prepare("DELETE FROM __meta WHERE key = ?").run("agentLogEntriesToFileMigrationVersion");
    db.prepare("UPDATE __meta SET value = '101' WHERE key = 'schemaVersion'").run();

    await harness.reopenDiskBackedStore();
    await harness.reopenDiskBackedStore();

    const reopenedDb = harness.store().getDatabase();
    const hasTable = reopenedDb
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agentLogEntries' LIMIT 1")
      .get();

    expect(reopenedDb.getSchemaVersion()).toBe(SCHEMA_VERSION);
    expect(hasTable).toBeUndefined();
  });
});
