import { beforeEach, describe, expect, it } from "vitest";

import { TaskStore } from "../store.js";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";

describe("TaskStore.getDatabaseHealth", () => {
  const harness = createTaskStoreTestHarness();
  let store: TaskStore;

  beforeEach(async () => {
    await harness.beforeEach();
    store = harness.store();
  });

  it("reports healthy by default before corruption is detected", () => {
    const health = store.getDatabaseHealth();

    expect(health.healthy).toBe(true);
    expect(health.corruptionDetected).toBe(false);
    expect(health.corruptionErrors).toEqual([]);
    expect(health.isRunning).toBe(false);
    expect(health.lastCheckedAt).toBeNull();
  });

  it("reports an in-progress integrity check", () => {
    const db = store.getDatabase();
    db.integrityCheckPending = true;

    const health = store.getDatabaseHealth();

    expect(health.healthy).toBe(true);
    expect(health.corruptionDetected).toBe(false);
    expect(health.corruptionErrors).toEqual([]);
    expect(health.isRunning).toBe(true);
  });

  it("reports unhealthy when corruption has been detected", () => {
    const db = store.getDatabase();
    db.corruptionDetected = true;
    db.integrityCheckErrors = ["bad row", "bad index"];
    db.integrityCheckPending = false;
    db.integrityCheckLastRunAt = "2026-05-11T12:34:56.000Z";

    const health = store.getDatabaseHealth();

    expect(health.healthy).toBe(false);
    expect(health.corruptionDetected).toBe(true);
    expect(health.corruptionErrors).toEqual(["bad row", "bad index"]);
    expect(health.isRunning).toBe(false);
    expect(health.lastCheckedAt?.toISOString()).toBe("2026-05-11T12:34:56.000Z");
  });

  it("caps corruption errors to the first five entries", () => {
    const db = store.getDatabase();
    db.corruptionDetected = true;
    db.integrityCheckErrors = ["one", "two", "three", "four", "five", "six"];

    const health = store.getDatabaseHealth();

    expect(health.corruptionErrors).toEqual(["one", "two", "three", "four", "five"]);
  });
});

describe("TaskStore.refreshDatabaseHealth", () => {
  const harness = createTaskStoreTestHarness();
  let store: TaskStore;

  beforeEach(async () => {
    await harness.beforeEach();
    store = harness.store();
  });

  it("clears a stale corruption flag after the underlying DB is repaired", () => {
    const db = store.getDatabase();
    db.corruptionDetected = true;
    db.integrityCheckErrors = ["wrong # of entries in index sqlite_autoindex_tasks_1"];
    db.integrityCheckLastRunAt = "2026-05-11T12:34:56.000Z";

    expect(store.getDatabaseHealth().corruptionDetected).toBe(true);

    const health = store.refreshDatabaseHealth();

    expect(health.corruptionDetected).toBe(false);
    expect(health.healthy).toBe(true);
    expect(health.corruptionErrors).toEqual([]);
    expect(health.isRunning).toBe(false);
    expect(health.lastCheckedAt).not.toBeNull();
    expect(health.lastCheckedAt?.toISOString()).not.toBe("2026-05-11T12:34:56.000Z");
  });
});
