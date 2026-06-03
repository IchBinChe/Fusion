import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as extractor from "../goal-citation-extractor.js";
import { getAgentLogFilePath, readAgentLogEntries } from "../agent-log-file-store.js";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";

describe("goal citations store integration", () => {
  const harness = createTaskStoreTestHarness();

  beforeEach(async () => {
    await harness.beforeEach();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await harness.afterEach();
  });

  it("records agent_log citations for goal IDs", async () => {
    const store = harness.store();
    const task = await store.createTask({ title: "Task", description: "desc" });

    await store.appendAgentLog(task.id, "working on G-FAKE001 now", "text", undefined, "executor");
    (store as any).flushAgentLogBuffer();

    const rows = store.listGoalCitations({ goalId: "G-FAKE001" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      goalId: "G-FAKE001",
      agentId: "executor",
      taskId: task.id,
      surface: "agent_log",
    });
    expect(rows[0]?.sourceRef).toMatch(/^agentLog:[^:]+:\d+$/);
  });

  it("does not record citations for near-miss log text", async () => {
    const store = harness.store();
    const task = await store.createTask({ title: "Task", description: "desc" });

    await store.appendAgentLog(task.id, "text with FN-9999 only", "text", undefined, "executor");
    (store as any).flushAgentLogBuffer();

    expect(store.listGoalCitations()).toHaveLength(0);
  });

  it("records task_document citations and sourceRef shape", async () => {
    const store = harness.store();
    const task = await store.createTask({ title: "Task", description: "desc" });

    await store.upsertTaskDocument(task.id, {
      key: "notes",
      content: "check G-ALPHA and G-BETA now",
      author: "agent",
    });

    const rows = store.listGoalCitations({ surface: "task_document" });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.sourceRef.startsWith(`document:${task.id}:notes:rev1`))).toBe(true);
  });

  it("records citations from appendAgentLogBatch seam", async () => {
    const store = harness.store();
    const task = await store.createTask({ title: "Task", description: "desc" });

    await store.appendAgentLogBatch([
      { taskId: task.id, text: "tracking G-BATCH001", type: "text", agent: "executor" },
    ]);

    const rows = store.listGoalCitations({ goalId: "G-BATCH001" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ surface: "agent_log", agentId: "executor", taskId: task.id });
    expect(rows[0]?.sourceRef).toMatch(new RegExp(`^agentLog:${task.id}:\\d+$`));
  });

  it("deduplicates goal citations per goalId+surface+sourceRef", () => {
    const store = harness.store();
    const inserted = store.recordGoalCitations([
      {
        goalId: "G-DUP",
        agentId: "agent-1",
        taskId: "FN-1",
        surface: "task_document",
        sourceRef: "document:FN-1:plan:rev3",
        snippet: "mentions G-DUP",
      },
      {
        goalId: "G-DUP",
        agentId: "agent-1",
        taskId: "FN-1",
        surface: "task_document",
        sourceRef: "document:FN-1:plan:rev3",
        snippet: "mentions G-DUP",
      },
    ]);

    expect(inserted).toHaveLength(1);
    expect(store.listGoalCitations({ goalId: "G-DUP" })).toHaveLength(1);
  });

  it("re-upserting same citation source is deduped", async () => {
    const store = harness.store();
    const task = await store.createTask({ title: "Task", description: "desc" });

    await store.upsertTaskDocument(task.id, {
      key: "plan",
      content: "first G-SAME",
      author: "agent",
    });
    const firstRows = store.listGoalCitations({ goalId: "G-SAME" });
    expect(firstRows).toHaveLength(1);

    const insertedAgain = store.recordGoalCitations([
      {
        goalId: "G-SAME",
        agentId: "agent",
        taskId: task.id,
        surface: "task_document",
        sourceRef: `document:${task.id}:plan:rev1`,
        snippet: "G-SAME",
      },
    ]);
    expect(insertedAgain).toHaveLength(0);
  });

  it("filters by goal and time window in descending timestamp order", () => {
    const store = harness.store();
    store.recordGoalCitations([
      {
        goalId: "G-WIN",
        agentId: "agent-1",
        surface: "agent_log",
        sourceRef: "agentLog:FN-WIN-1:1",
        snippet: "G-WIN older",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
      {
        goalId: "G-WIN",
        agentId: "agent-1",
        surface: "agent_log",
        sourceRef: "agentLog:FN-WIN-1:2",
        snippet: "G-WIN newer",
        timestamp: "2026-01-02T00:00:00.000Z",
      },
      {
        goalId: "G-OTHER",
        agentId: "agent-1",
        surface: "agent_log",
        sourceRef: "agentLog:FN-OTHER-1:1",
        snippet: "other",
        timestamp: "2026-01-02T00:00:00.000Z",
      },
    ]);

    const rows = store.listGoalCitations({
      goalId: "G-WIN",
      startTime: "2026-01-01T12:00:00.000Z",
      endTime: "2026-01-03T00:00:00.000Z",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.sourceRef).toBe("agentLog:FN-WIN-1:2");
  });

  it("keeps citation source refs stable and resolvable after re-reading logs from file", async () => {
    const store = harness.store();
    const task = await store.createTask({ title: "Task", description: "desc" });

    await store.appendAgentLogBatch([
      { taskId: task.id, text: "tracking G-STABLE001", type: "text", agent: "executor" },
      { taskId: task.id, text: "tracking G-STABLE002", type: "text", agent: "executor" },
    ]);

    const rows = store.listGoalCitations({ taskId: task.id, surface: "agent_log" });
    expect(rows.map((row) => row.sourceRef)).toEqual([
      `agentLog:${task.id}:2`,
      `agentLog:${task.id}:1`,
    ]);

    const persistedLogs = readAgentLogEntries(join(harness.rootDir(), ".fusion", "tasks", task.id));
    const bySourceRef = new Map(persistedLogs.map((entry) => [entry.sourceRef, entry]));
    expect(bySourceRef.get(`agentLog:${task.id}:1`)?.text).toBe("tracking G-STABLE001");
    expect(bySourceRef.get(`agentLog:${task.id}:2`)?.text).toBe("tracking G-STABLE002");
    expect(getAgentLogFilePath(join(harness.rootDir(), ".fusion", "tasks", task.id))).toContain(
      `/tasks/${task.id}/agent-log.jsonl`,
    );
  });

  it("does not throw when citation scan fails during appendAgentLog", async () => {
    const store = harness.store();
    const task = await store.createTask({ title: "Task", description: "desc" });
    vi.spyOn(extractor, "extractGoalCitations").mockImplementation(() => {
      throw new Error("boom");
    });

    await expect(store.appendAgentLog(task.id, "G-FAKE001", "text", undefined, "executor")).resolves.toBeUndefined();
    expect(() => (store as any).flushAgentLogBuffer()).not.toThrow();

    const logs = await store.getAgentLogs(task.id);
    expect(logs).toHaveLength(1);
  });
});
