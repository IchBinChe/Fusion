/**
 * Covers AI session persistence store round-trips, lifecycle transitions,
 * cleanup/recovery behavior, and debounce/emit semantics.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Database } from "@fusion/core";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AiSessionStore,
  type AiSessionRow,
  type AiSessionSummary,
} from "../ai-session-store.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-ai-session-store-tests-"));
}

function makeRow(
  id: string,
  overrides: Partial<AiSessionRow> = {},
): AiSessionRow {
  const now = new Date().toISOString();
  return {
    id,
    type: "planning",
    status: "generating",
    title: `Session ${id}`,
    inputPayload: JSON.stringify({ initialPlan: `Plan ${id}`, ip: "127.0.0.1" }),
    conversationHistory: JSON.stringify([]),
    currentQuestion: null,
    result: null,
    thinkingOutput: "",
    error: null,
    projectId: null,
    createdAt: now,
    updatedAt: now,
    lockedByTab: null,
    lockedAt: null,
    ...overrides,
  };
}

describe("AiSessionStore (__tests__)", () => {
  let tmpDir: string;
  let kbDir: string;
  let db: Database;
  let store: AiSessionStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    kbDir = join(tmpDir, ".fusion");
    db = new Database(kbDir);
    db.init();
    store = new AiSessionStore(db);
  });

  afterEach(async () => {
    store.stopScheduledCleanup();
    store.removeAllListeners();
    vi.useRealTimers();
    try {
      db.close();
    } catch {
      // no-op
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("round-trips full session payload via upsert/get", () => {
    const history = [
      {
        question: { id: "q-1", type: "text", question: "What should we build?" },
        response: { "q-1": "A planner" },
        thinkingOutput: "first-think",
      },
      {
        question: { id: "q-2", type: "confirm", question: "Need tests?" },
        response: { "q-2": true },
        thinkingOutput: "second-think",
      },
    ];
    const currentQuestion = {
      id: "q-3",
      type: "single_select",
      question: "Target size?",
      options: [{ id: "m", label: "Medium" }],
    };
    const result = {
      title: "Planner task",
      description: "A complete planning summary",
      suggestedSize: "M",
      suggestedDependencies: ["FN-100"],
      keyDeliverables: ["API", "UI", "Tests"],
    };

    const row = makeRow("sess-roundtrip", {
      status: "awaiting_input",
      title: "Roundtrip Session",
      inputPayload: JSON.stringify({ initialPlan: "Build planning", ip: "10.0.0.1" }),
      conversationHistory: JSON.stringify(history),
      currentQuestion: JSON.stringify(currentQuestion),
      result: JSON.stringify(result),
      thinkingOutput: "Thought stream",
      error: null,
      projectId: "proj-a",
    });

    store.upsert(row);

    const persisted = store.get(row.id);
    expect(persisted).not.toBeNull();
    expect(persisted).toMatchObject({
      id: row.id,
      type: "planning",
      status: "awaiting_input",
      title: "Roundtrip Session",
      projectId: "proj-a",
      thinkingOutput: "Thought stream",
      error: null,
    });
    expect(JSON.parse(persisted!.inputPayload)).toEqual(JSON.parse(row.inputPayload));
    expect(JSON.parse(persisted!.conversationHistory)).toEqual(history);
    expect(JSON.parse(persisted!.currentQuestion ?? "null")).toEqual(currentQuestion);
    expect(JSON.parse(persisted!.result ?? "null")).toEqual(result);
  });

  it("upsert updates an existing row on id conflict", () => {
    const id = "sess-conflict";
    store.upsert(
      makeRow(id, {
        status: "generating",
        conversationHistory: JSON.stringify([{ question: { id: "q-1" }, response: { "q-1": "initial" } }]),
      }),
    );

    store.upsert(
      makeRow(id, {
        status: "error",
        conversationHistory: JSON.stringify([{ question: { id: "q-1" }, response: { "q-1": "updated" } }]),
        error: "Failed to parse AI response",
      }),
    );

    const rowCount = db.prepare("SELECT COUNT(*) as count FROM ai_sessions WHERE id = ?").get(id) as {
      count: number;
    };
    expect(rowCount.count).toBe(1);

    const updated = store.get(id);
    expect(updated?.status).toBe("error");
    expect(updated?.error).toBe("Failed to parse AI response");
    expect(JSON.parse(updated?.conversationHistory ?? "[]")).toEqual([
      { question: { id: "q-1" }, response: { "q-1": "updated" } },
    ]);
  });

  it("listActive returns only generating/awaiting_input/error ordered by updatedAt desc", () => {
    store.upsert(makeRow("active-generating", { status: "generating" }));
    store.upsert(makeRow("active-awaiting", { status: "awaiting_input" }));
    store.upsert(makeRow("inactive-complete", { status: "complete" }));
    store.upsert(makeRow("active-error", { status: "error" }));

    db.prepare("UPDATE ai_sessions SET updatedAt = ? WHERE id = ?").run("2026-01-01T00:00:01.000Z", "active-generating");
    db.prepare("UPDATE ai_sessions SET updatedAt = ? WHERE id = ?").run("2026-01-01T00:00:03.000Z", "active-awaiting");
    db.prepare("UPDATE ai_sessions SET updatedAt = ? WHERE id = ?").run("2026-01-01T00:00:02.000Z", "active-error");
    db.prepare("UPDATE ai_sessions SET updatedAt = ? WHERE id = ?").run("2026-01-01T00:00:04.000Z", "inactive-complete");

    const active = store.listActive();

    expect(active.map((item) => item.id)).toEqual([
      "active-awaiting",
      "active-error",
      "active-generating",
    ]);
    expect(active.every((item) => ["generating", "awaiting_input", "error"].includes(item.status))).toBe(true);
  });

  it("listActive filters by projectId", () => {
    store.upsert(makeRow("a-1", { status: "generating", projectId: "proj-a" }));
    store.upsert(makeRow("a-2", { status: "awaiting_input", projectId: "proj-a" }));
    store.upsert(makeRow("a-3", { status: "error", projectId: "proj-a" }));
    store.upsert(makeRow("b-1", { status: "generating", projectId: "proj-b" }));
    store.upsert(makeRow("a-complete", { status: "complete", projectId: "proj-a" }));

    const filtered = store.listActive("proj-a");

    expect(filtered.map((row) => row.id).sort()).toEqual(["a-1", "a-2", "a-3"]);
    expect(filtered.every((row) => row.projectId === "proj-a")).toBe(true);
  });

  it("delete removes row and emits ai_session:deleted", () => {
    const onDeleted = vi.fn();
    store.on("ai_session:deleted", onDeleted);

    store.upsert(makeRow("sess-delete", { status: "awaiting_input" }));
    expect(store.get("sess-delete")).not.toBeNull();

    store.delete("sess-delete");

    expect(store.get("sess-delete")).toBeNull();
    expect(onDeleted).toHaveBeenCalledWith("sess-delete");
  });

  it("recoverStaleSessions promotes recoverable rows and errors unrecoverable ones", () => {
    store.upsert(
      makeRow("recoverable", {
        status: "generating",
        currentQuestion: JSON.stringify({ id: "q-1", type: "text", question: "Continue?" }),
      }),
    );
    store.upsert(makeRow("unrecoverable", { status: "generating", currentQuestion: null }));

    const changed = store.recoverStaleSessions();

    expect(changed).toBe(2);
    expect(store.get("recoverable")?.status).toBe("awaiting_input");
    expect(store.get("unrecoverable")?.status).toBe("error");
    expect(store.get("unrecoverable")?.error).toContain("Session interrupted");
  });

  it("cleanupOld removes only old terminal rows", () => {
    store.upsert(makeRow("old-complete", { status: "complete" }));
    store.upsert(makeRow("old-error", { status: "error" }));
    store.upsert(makeRow("old-generating", { status: "generating" }));
    store.upsert(makeRow("fresh-complete", { status: "complete" }));

    const staleTs = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
    const freshTs = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    db.prepare("UPDATE ai_sessions SET updatedAt = ? WHERE id IN (?, ?, ?)").run(
      staleTs,
      "old-complete",
      "old-error",
      "old-generating",
    );
    db.prepare("UPDATE ai_sessions SET updatedAt = ? WHERE id = ?").run(freshTs, "fresh-complete");

    const removed = store.cleanupOld(60 * 60 * 1000);

    expect(removed).toBe(2);
    expect(store.get("old-complete")).toBeNull();
    expect(store.get("old-error")).toBeNull();
    expect(store.get("old-generating")).not.toBeNull();
    expect(store.get("fresh-complete")).not.toBeNull();
  });

  it("trims thinkingOutput to the last 50KB on upsert", () => {
    const maxBytes = 50 * 1024;
    const oversized = `${"x".repeat(1024)}${"y".repeat(maxBytes + 2000)}`;

    store.upsert(makeRow("sess-thinking-trim", { thinkingOutput: oversized }));

    const persisted = store.get("sess-thinking-trim");
    expect(persisted).not.toBeNull();
    expect(persisted!.thinkingOutput.length).toBe(maxBytes);
    expect(persisted!.thinkingOutput).toBe(oversized.slice(oversized.length - maxBytes));
  });

  it("updateThinking debounces writes unless flush=true", () => {
    vi.useFakeTimers();
    store.upsert(makeRow("sess-thinking-debounce", { thinkingOutput: "initial" }));

    store.updateThinking("sess-thinking-debounce", "deferred-write");
    expect(store.get("sess-thinking-debounce")?.thinkingOutput).toBe("initial");

    vi.advanceTimersByTime(1999);
    expect(store.get("sess-thinking-debounce")?.thinkingOutput).toBe("initial");

    vi.advanceTimersByTime(1);
    expect(store.get("sess-thinking-debounce")?.thinkingOutput).toBe("deferred-write");

    store.updateThinking("sess-thinking-debounce", "queued-write");
    store.updateThinking("sess-thinking-debounce", "flushed-write", true);

    expect(store.get("sess-thinking-debounce")?.thinkingOutput).toBe("flushed-write");

    vi.advanceTimersByTime(5000);
    expect(store.get("sess-thinking-debounce")?.thinkingOutput).toBe("flushed-write");
  });

  it("emits ai_session:updated summary on upsert", () => {
    const onUpdated = vi.fn<[AiSessionSummary]>();
    store.on("ai_session:updated", onUpdated);

    store.upsert(
      makeRow("sess-event", {
        status: "awaiting_input",
        title: "Session Event",
        projectId: "proj-events",
      }),
    );

    expect(onUpdated).toHaveBeenCalledTimes(1);
    expect(onUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "sess-event",
        type: "planning",
        status: "awaiting_input",
        title: "Session Event",
        projectId: "proj-events",
        lockedByTab: null,
        updatedAt: expect.any(String),
      }),
    );
  });
});
