import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { CliSessionStore } from "../cli-session-store.js";
import { Database } from "../db.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-cli-session-store-test-"));
}

describe("CliSessionStore", () => {
  let tmpDir: string;
  let fusionDir: string;
  let db: Database;
  let store: CliSessionStore;

  beforeAll(() => {
    tmpDir = makeTmpDir();
    fusionDir = join(tmpDir, ".fusion");
    db = new Database(fusionDir, { inMemory: true });
    db.init();
    store = new CliSessionStore(fusionDir, db);
  });

  beforeEach(() => {
    db.exec("DELETE FROM cli_sessions");
    store.removeAllListeners();
  });

  afterAll(async () => {
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates and reads a session record", () => {
    const created = store.createSession({
      taskId: "FN-100",
      purpose: "execute",
      projectId: "proj-1",
      adapterId: "claude-local",
      worktreePath: "/tmp/wt/FN-100",
      autonomyPosture: { autoApprove: true, maxResumeAttempts: 3 },
    });

    expect(created.id).toMatch(/^cli-/);
    expect(created.agentState).toBe("starting");
    expect(created.terminationReason).toBeNull();
    expect(created.resumeAttempts).toBe(0);
    expect(created.chatSessionId).toBeNull();
    expect(created.autonomyPosture).toEqual({ autoApprove: true, maxResumeAttempts: 3 });

    const fetched = store.getSession(created.id);
    expect(fetched).toEqual(created);
  });

  it("persists state transitions", () => {
    const s = store.createSession({
      taskId: "FN-101",
      purpose: "planning",
      projectId: "proj-1",
      adapterId: "codex-local",
    });

    const states = ["ready", "busy", "waitingOnInput", "busy", "done"] as const;
    for (const state of states) {
      const updated = store.updateSession(s.id, { agentState: state });
      expect(updated?.agentState).toBe(state);
      // Persisted, not just returned.
      expect(store.getSession(s.id)?.agentState).toBe(state);
    }
  });

  it("round-trips the native session id", () => {
    const s = store.createSession({
      taskId: "FN-102",
      purpose: "execute",
      projectId: "proj-1",
      adapterId: "claude-local",
    });
    expect(s.nativeSessionId).toBeNull();

    store.updateSession(s.id, { nativeSessionId: "native-abc-123" });
    expect(store.getSession(s.id)?.nativeSessionId).toBe("native-abc-123");

    // Reopen via a fresh store instance on the same DB to prove durability.
    const reopened = new CliSessionStore(fusionDir, db);
    expect(reopened.getSession(s.id)?.nativeSessionId).toBe("native-abc-123");
  });

  it("updates terminationReason and resumeAttempts atomically with state", () => {
    const s = store.createSession({
      taskId: "FN-103",
      purpose: "validator",
      projectId: "proj-1",
      adapterId: "claude-local",
    });

    const updated = store.updateSession(s.id, {
      agentState: "dead",
      terminationReason: "crashed",
      resumeAttempts: 2,
    });

    expect(updated?.agentState).toBe("dead");
    expect(updated?.terminationReason).toBe("crashed");
    expect(updated?.resumeAttempts).toBe(2);

    const persisted = store.getSession(s.id)!;
    expect(persisted.agentState).toBe("dead");
    expect(persisted.terminationReason).toBe("crashed");
    expect(persisted.resumeAttempts).toBe(2);
  });

  it("clears terminationReason when set back to null", () => {
    const s = store.createSession({
      taskId: "FN-104",
      purpose: "execute",
      projectId: "proj-1",
      adapterId: "claude-local",
      agentState: "dead",
      terminationReason: "killed",
    });
    expect(s.terminationReason).toBe("killed");

    store.updateSession(s.id, { agentState: "starting", terminationReason: null });
    const persisted = store.getSession(s.id)!;
    expect(persisted.terminationReason).toBeNull();
    expect(persisted.agentState).toBe("starting");
  });

  it("queries sessions by task and by chat entity", () => {
    store.createSession({ taskId: "FN-200", purpose: "execute", projectId: "p", adapterId: "a" });
    store.createSession({ taskId: "FN-200", purpose: "validator", projectId: "p", adapterId: "a" });
    store.createSession({ taskId: "FN-201", purpose: "execute", projectId: "p", adapterId: "a" });
    store.createSession({ chatSessionId: "chat-xyz", purpose: "chat", projectId: "p", adapterId: "a" });

    expect(store.listByTask("FN-200")).toHaveLength(2);
    expect(store.listByTask("FN-201")).toHaveLength(1);
    expect(store.listByTask("FN-999")).toHaveLength(0);

    const chatSessions = store.listByChatSession("chat-xyz");
    expect(chatSessions).toHaveLength(1);
    expect(chatSessions[0].purpose).toBe("chat");
  });

  it("filters by projectId and agentState", () => {
    store.createSession({ taskId: "FN-300", purpose: "execute", projectId: "pA", adapterId: "a", agentState: "busy" });
    store.createSession({ taskId: "FN-301", purpose: "execute", projectId: "pA", adapterId: "a", agentState: "done" });
    store.createSession({ taskId: "FN-302", purpose: "execute", projectId: "pB", adapterId: "a", agentState: "busy" });

    expect(store.listSessions({ projectId: "pA" })).toHaveLength(2);
    expect(store.listSessions({ projectId: "pA", agentState: "busy" })).toHaveLength(1);
    expect(store.listSessions({ agentState: "busy" })).toHaveLength(2);
  });

  it("rejects an invalid agent state at the store boundary", () => {
    const s = store.createSession({
      taskId: "FN-400",
      purpose: "execute",
      projectId: "p",
      adapterId: "a",
    });

    expect(() =>
      // @ts-expect-error invalid state value rejected at runtime
      store.updateSession(s.id, { agentState: "bogus" }),
    ).toThrow(/Invalid CLI agent state/);

    expect(() =>
      // @ts-expect-error invalid state value rejected at runtime
      store.createSession({ purpose: "execute", projectId: "p", adapterId: "a", agentState: "nope" }),
    ).toThrow(/Invalid CLI agent state/);

    // The original record was untouched by the failed update.
    expect(store.getSession(s.id)?.agentState).toBe("starting");
  });

  it("rejects an invalid purpose and termination reason at the store boundary", () => {
    expect(() =>
      // @ts-expect-error invalid purpose rejected at runtime
      store.createSession({ purpose: "wat", projectId: "p", adapterId: "a" }),
    ).toThrow(/Invalid CLI session purpose/);

    const s = store.createSession({ taskId: "FN-401", purpose: "execute", projectId: "p", adapterId: "a" });
    expect(() =>
      // @ts-expect-error invalid termination reason rejected at runtime
      store.updateSession(s.id, { terminationReason: "exploded" }),
    ).toThrow(/Invalid CLI termination reason/);
  });

  it("emits create/update/delete events", () => {
    const events: string[] = [];
    store.on("cli-session:created", () => events.push("created"));
    store.on("cli-session:updated", () => events.push("updated"));
    store.on("cli-session:deleted", () => events.push("deleted"));

    const s = store.createSession({ taskId: "FN-500", purpose: "ce", projectId: "p", adapterId: "a" });
    store.updateSession(s.id, { agentState: "ready" });
    expect(store.deleteSession(s.id)).toBe(true);
    expect(store.getSession(s.id)).toBeUndefined();

    expect(events).toEqual(["created", "updated", "deleted"]);
  });

  it("returns undefined when updating a missing session and false when deleting one", () => {
    expect(store.updateSession("cli-missing", { agentState: "ready" })).toBeUndefined();
    expect(store.deleteSession("cli-missing")).toBe(false);
  });
});
