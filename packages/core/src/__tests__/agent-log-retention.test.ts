import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  countAgentLogEntries,
  getAgentLogFilePath,
  pruneAgentLogFiles,
  readAgentLogEntries,
} from "../agent-log-file-store.js";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";

describe("Agent log file retention pruning", () => {
  const harness = createTaskStoreTestHarness();

  const taskDir = (taskId: string) => join(harness.rootDir(), ".fusion", "tasks", taskId);

  beforeEach(async () => {
    await harness.beforeEach();
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  it("returns zeroed counts when retention is disabled", () => {
    const result = pruneAgentLogFiles(join(harness.rootDir(), ".fusion", "tasks"), 0);
    expect(result).toEqual({ prunedFiles: 0, prunedEntries: 0, freedBytes: 0 });
  });

  it("returns zeroed counts when retention is negative", () => {
    const result = pruneAgentLogFiles(join(harness.rootDir(), ".fusion", "tasks"), -5);
    expect(result).toEqual({ prunedFiles: 0, prunedEntries: 0, freedBytes: 0 });
  });

  it("returns zeroed counts when tasksDir does not exist", () => {
    const result = pruneAgentLogFiles("/nonexistent/path", 30);
    expect(result).toEqual({ prunedFiles: 0, prunedEntries: 0, freedBytes: 0 });
  });

  it("removes old entries and keeps recent ones", async () => {
    const store = harness.store();
    const task = await harness.createTestTask();

    // Write entries with controlled timestamps
    const td = taskDir(task.id);
    mkdirSync(td, { recursive: true });
    const filePath = getAgentLogFilePath(td);
    const oldEntry = JSON.stringify({
      timestamp: "2020-01-01T00:00:00.000Z",
      taskId: task.id,
      text: "old-entry",
      type: "text",
    });
    const recentEntry = JSON.stringify({
      timestamp: "2099-06-01T00:00:00.000Z",
      taskId: task.id,
      text: "recent-entry",
      type: "text",
    });
    writeFileSync(filePath, `${oldEntry}\n${recentEntry}\n`, "utf8");

    expect(countAgentLogEntries(td)).toBe(2);

    const result = pruneAgentLogFiles(
      join(harness.rootDir(), ".fusion", "tasks"),
      30,
      new Set([task.id]),
    );

    expect(result.prunedEntries).toBe(1);
    expect(result.prunedFiles).toBe(1);
    expect(result.freedBytes).toBeGreaterThan(0);

    const remaining = readAgentLogEntries(td);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.text).toBe("recent-entry");
  });

  it("deletes the file when all entries are pruned", async () => {
    const store = harness.store();
    const task = await harness.createTestTask();

    const td = taskDir(task.id);
    mkdirSync(td, { recursive: true });
    const filePath = getAgentLogFilePath(td);
    const oldEntry = JSON.stringify({
      timestamp: "2020-01-01T00:00:00.000Z",
      taskId: task.id,
      text: "old-entry-1",
      type: "text",
    });
    writeFileSync(filePath, `${oldEntry}\n`, "utf8");

    expect(existsSync(filePath)).toBe(true);

    const result = pruneAgentLogFiles(
      join(harness.rootDir(), ".fusion", "tasks"),
      30,
      new Set([task.id]),
    );

    expect(result.prunedEntries).toBe(1);
    expect(result.prunedFiles).toBe(1);
    expect(existsSync(filePath)).toBe(false);
  });

  it("keeps malformed lines intact (does not destroy unparseable data)", async () => {
    const store = harness.store();
    const task = await harness.createTestTask();

    const td = taskDir(task.id);
    mkdirSync(td, { recursive: true });
    const filePath = getAgentLogFilePath(td);
    const content = "not-valid-json\n";
    writeFileSync(filePath, content, "utf8");

    const result = pruneAgentLogFiles(
      join(harness.rootDir(), ".fusion", "tasks"),
      30,
      new Set([task.id]),
    );

    // Malformed line is kept, nothing pruned
    expect(result.prunedEntries).toBe(0);
    expect(existsSync(filePath)).toBe(true);
  });

  it("scopes pruning to specified task IDs only", async () => {
    const store = harness.store();
    const task1 = await harness.createTestTask();
    const task2 = await harness.createTestTask();

    const td1 = taskDir(task1.id);
    const td2 = taskDir(task2.id);
    mkdirSync(td1, { recursive: true });
    mkdirSync(td2, { recursive: true });

    const oldEntry = (id: string) =>
      JSON.stringify({ timestamp: "2020-01-01T00:00:00.000Z", taskId: id, text: "old", type: "text" });

    writeFileSync(getAgentLogFilePath(td1), `${oldEntry(task1.id)}\n`, "utf8");
    writeFileSync(getAgentLogFilePath(td2), `${oldEntry(task2.id)}\n`, "utf8");

    // Only prune task1
    const result = pruneAgentLogFiles(
      join(harness.rootDir(), ".fusion", "tasks"),
      30,
      new Set([task1.id]),
    );

    expect(result.prunedEntries).toBe(1);
    expect(countAgentLogEntries(td1)).toBe(0);
    expect(countAgentLogEntries(td2)).toBe(1);
  });

  it("store.pruneAgentLogFiles only prunes inactive tasks", async () => {
    const store = harness.store();
    const activeTask = await harness.createTestTask();
    const deletedTask = await harness.createTestTask();

    // Write entries for both tasks
    const activeTd = taskDir(activeTask.id);
    const deletedTd = taskDir(deletedTask.id);

    const oldEntry = (id: string) =>
      JSON.stringify({ timestamp: "2020-01-01T00:00:00.000Z", taskId: id, text: "old", type: "text" });

    mkdirSync(activeTd, { recursive: true });
    mkdirSync(deletedTd, { recursive: true });
    writeFileSync(getAgentLogFilePath(activeTd), `${oldEntry(activeTask.id)}\n`, "utf8");
    writeFileSync(getAgentLogFilePath(deletedTd), `${oldEntry(deletedTask.id)}\n`, "utf8");

    // Soft-delete one task
    await store.deleteTask(deletedTask.id);

    const result = store.pruneAgentLogFiles(30);

    expect(result.prunedEntries).toBe(1);
    // Active task's log is untouched
    expect(countAgentLogEntries(activeTd)).toBe(1);
    // Deleted task's old entries are pruned
    expect(countAgentLogEntries(deletedTd)).toBe(0);
  });

  it("leaves in-range entries intact when mixed old/recent entries exist", async () => {
    const store = harness.store();
    const task = await harness.createTestTask();

    const td = taskDir(task.id);
    mkdirSync(td, { recursive: true });
    const filePath = getAgentLogFilePath(td);

    const lines = [
      JSON.stringify({ timestamp: "2020-01-01T00:00:00.000Z", taskId: task.id, text: "old-1", type: "text" }),
      JSON.stringify({ timestamp: "2099-06-01T00:00:00.000Z", taskId: task.id, text: "recent-1", type: "text" }),
      JSON.stringify({ timestamp: "2020-02-01T00:00:00.000Z", taskId: task.id, text: "old-2", type: "text" }),
      JSON.stringify({ timestamp: "2099-07-01T00:00:00.000Z", taskId: task.id, text: "recent-2", type: "text" }),
    ];
    writeFileSync(filePath, lines.join("\n") + "\n", "utf8");

    pruneAgentLogFiles(join(harness.rootDir(), ".fusion", "tasks"), 30, new Set([task.id]));

    const remaining = readAgentLogEntries(td);
    expect(remaining.map((e) => e.text)).toEqual(["recent-1", "recent-2"]);
  });
});
