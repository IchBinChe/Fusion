import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CliSessionStore } from "@fusion/core";
import { Database } from "@fusion/core";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import {
  CliSessionStateMachine,
  classifyTermination,
  isResumeEligible,
  looksLikeAuthFailure,
  InvalidCliTransitionError,
  type CliStateChange,
} from "../state-machine.js";

describe("CliSessionStateMachine", () => {
  let tmpDir: string;
  let fusionDir: string;
  let db: Database;
  let store: CliSessionStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kb-cli-sm-test-"));
    fusionDir = join(tmpDir, ".fusion");
    db = new Database(fusionDir, { inMemory: true });
    db.init();
    store = new CliSessionStore(fusionDir, db);
    vi.useRealTimers();
  });

  afterEach(async () => {
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function seedSession(overrides: Record<string, unknown> = {}): string {
    const s = store.createSession({
      purpose: "execute",
      projectId: "proj",
      adapterId: "claude-code",
      ...overrides,
    });
    return s.id;
  }

  function makeMachine(
    sessionId: string,
    opts: Partial<ConstructorParameters<typeof CliSessionStateMachine>[0]> = {},
  ): CliSessionStateMachine {
    return new CliSessionStateMachine({ sessionId, store, ...opts });
  }

  // ── AE1: native done advances; idle never does ───────────────────────────

  it("AE1: positive done signal advances busy → done; persists", () => {
    const id = seedSession();
    const m = makeMachine(id);
    m.markReady();
    m.injectPrompt();
    expect(m.getState()).toBe("busy");
    m.signalDone();
    expect(m.getState()).toBe("done");
    expect(store.getSession(id)?.agentState).toBe("done");
    expect(store.getSession(id)?.terminationReason).toBe("completed");
  });

  it("AE1: idle / output progress NEVER advances to done", () => {
    const id = seedSession();
    const m = makeMachine(id);
    m.markReady();
    m.injectPrompt();
    m.signalOutputProgress();
    m.signalOutputProgress();
    expect(m.getState()).toBe("busy"); // never done
  });

  // ── AE2: permission prompt → waitingOnInput, no advance/fail ──────────────

  it("AE2: waitingOnInput holds state (neither advances nor fails) and is reversible", () => {
    const id = seedSession();
    const m = makeMachine(id);
    m.markReady();
    m.injectPrompt();
    m.signalWaitingOnInput();
    expect(m.getState()).toBe("waitingOnInput");
    expect(store.getSession(id)?.agentState).toBe("waitingOnInput");
    m.signalBusy(); // user answered
    expect(m.getState()).toBe("busy");
  });

  // ── Stall backstop ───────────────────────────────────────────────────────

  it("stall backstop fires on a quiet busy turn past threshold → needsAttention", () => {
    vi.useFakeTimers();
    const id = seedSession();
    const m = makeMachine(id, { stallThresholdMs: 1000 });
    m.markReady();
    m.injectPrompt();
    vi.advanceTimersByTime(1000);
    expect(m.getState()).toBe("needsAttention");
  });

  it("stall backstop NEVER fires on a streaming session (re-armed by output)", () => {
    vi.useFakeTimers();
    const id = seedSession();
    const m = makeMachine(id, { stallThresholdMs: 1000 });
    m.markReady();
    m.injectPrompt();
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(900);
      m.signalOutputProgress(); // re-arm
    }
    vi.advanceTimersByTime(900);
    expect(m.getState()).toBe("busy");
  });

  it("stall backstop suppressed while waitingOnInput", () => {
    vi.useFakeTimers();
    const id = seedSession();
    const m = makeMachine(id, { stallThresholdMs: 1000 });
    m.markReady();
    m.injectPrompt();
    m.signalWaitingOnInput();
    vi.advanceTimersByTime(5000);
    expect(m.getState()).toBe("waitingOnInput"); // no backstop while waiting
  });

  // ── Termination classification — all five paths ──────────────────────────

  it("classifies clean exit-0 mid-task → userExited", () => {
    expect(classifyTermination({ exitCode: 0, hadDone: false })).toBe("userExited");
  });

  it("classifies SIGKILL-from-cancel → killed (no resume)", () => {
    const reason = classifyTermination({ cancelled: true, signal: "SIGKILL" });
    expect(reason).toBe("killed");
    expect(isResumeEligible(reason)).toBe(false);
  });

  it("classifies nonzero exit → crashed (resume-eligible)", () => {
    const reason = classifyTermination({ exitCode: 1 });
    expect(reason).toBe("crashed");
    expect(isResumeEligible(reason)).toBe(true);
  });

  it("classifies credential-failure pattern → authFailed", () => {
    expect(
      classifyTermination({ exitCode: 1, recentOutput: "Error: Invalid API key" }),
    ).toBe("authFailed");
    expect(looksLikeAuthFailure("authentication failed")).toBe(true);
    expect(looksLikeAuthFailure("all good")).toBe(false);
  });

  it("classifies found-dead-on-restart → engineDeath (resume-eligible)", () => {
    const reason = classifyTermination({ foundDeadOnRestart: true });
    expect(reason).toBe("engineDeath");
    expect(isResumeEligible(reason)).toBe(true);
  });

  it("processEnded(crashed) routes busy → resuming", () => {
    const id = seedSession();
    const m = makeMachine(id);
    m.markReady();
    m.injectPrompt();
    const reason = m.processEnded({ exitCode: 1 });
    expect(reason).toBe("crashed");
    expect(m.getState()).toBe("resuming");
    expect(store.getSession(id)?.terminationReason).toBe("crashed");
  });

  it("processEnded(killed) lands on dead with killed reason", () => {
    const id = seedSession();
    const m = makeMachine(id);
    m.markReady();
    m.injectPrompt();
    const reason = m.processEnded({ cancelled: true });
    expect(reason).toBe("killed");
    expect(m.getState()).toBe("dead");
  });

  // ── Resume caps ──────────────────────────────────────────────────────────

  it("resume cap: two failures → needsAttention, third never attempted", () => {
    const id = seedSession();
    const m = makeMachine(id);
    m.markReady();
    m.injectPrompt();
    m.processEnded({ exitCode: 1 }); // → resuming
    m.recordResumeResult(false); // attempt 1 fails
    expect(m.getState()).toBe("resuming");
    expect(m.getResumeAttempts()).toBe(1);
    m.recordResumeResult(false); // attempt 2 fails → cap
    expect(m.getState()).toBe("needsAttention");
    expect(m.getResumeAttempts()).toBe(2);
    // No third attempt possible (not in resuming).
    expect(() => m.recordResumeResult(false)).toThrow(InvalidCliTransitionError);
  });

  it("resume success returns to busy and resets attempts", () => {
    const id = seedSession();
    const m = makeMachine(id);
    m.markReady();
    m.injectPrompt();
    m.processEnded({ exitCode: 1 });
    m.recordResumeResult(false); // 1 fail
    m.recordResumeResult(true); // succeed
    expect(m.getState()).toBe("busy");
    expect(m.getResumeAttempts()).toBe(0);
  });

  it("resume backoff metadata grows per attempt", () => {
    const id = seedSession();
    const changes: CliStateChange[] = [];
    const m = makeMachine(id, { resumeBackoffBaseMs: 100, maxResumeAttempts: 5 });
    m.onStateChange((c) => changes.push(c));
    m.markReady();
    m.injectPrompt();
    m.processEnded({ exitCode: 1 });
    m.recordResumeResult(false); // attempt 1 → backoff 100
    m.recordResumeResult(false); // attempt 2 → backoff 200
    const backoffs = changes.filter((c) => c.resumeBackoffMs != null).map((c) => c.resumeBackoffMs);
    expect(backoffs).toEqual([100, 200]);
  });

  // ── Follow-up + per-turn latch reset ─────────────────────────────────────

  it("done → busy follow-up resets per-turn done latch (two turns one handler)", () => {
    vi.useFakeTimers();
    const id = seedSession();
    const m = makeMachine(id, { stallThresholdMs: 1000 });
    m.markReady();
    m.injectPrompt();
    m.signalDone();
    expect(m.getState()).toBe("done");
    // Second turn through the same handler: follow-up re-arms a fresh turn.
    m.followUp();
    expect(m.getState()).toBe("busy");
    // The new turn's stall watchdog is fresh (latch reset) — a quiet turn trips it.
    vi.advanceTimersByTime(1000);
    expect(m.getState()).toBe("needsAttention");
  });

  // ── needsAttention escalation ────────────────────────────────────────────

  it("userExited dead landing can escalate to needsAttention preserving reason", () => {
    const id = seedSession();
    const m = makeMachine(id);
    m.markReady();
    m.injectPrompt();
    m.processEnded({ exitCode: 0 }); // userExited → dead
    expect(m.getState()).toBe("dead");
    m.escalateToNeedsAttention();
    expect(m.getState()).toBe("needsAttention");
    expect(store.getSession(id)?.terminationReason).toBe("userExited");
  });

  // ── Throttled emission ───────────────────────────────────────────────────

  it("throttled onStateChange coalesces rapid transitions", () => {
    vi.useFakeTimers();
    const id = seedSession();
    let nowMs = 0;
    const changes: CliStateChange[] = [];
    const m = makeMachine(id, {
      stateChangeThrottleMs: 100,
      now: () => nowMs,
    });
    m.onStateChange((c) => changes.push(c));
    m.markReady(); // emits immediately (first)
    m.injectPrompt(); // within window → coalesced
    m.signalWaitingOnInput(); // within window → coalesced
    expect(changes.length).toBe(1);
    nowMs = 100;
    vi.advanceTimersByTime(100);
    // The latest coalesced change is delivered at the window edge.
    expect(changes.length).toBe(2);
    expect(changes[1].state).toBe("waitingOnInput");
  });

  // ── Rebuild from persisted record ────────────────────────────────────────

  it("rebuilds state from the persisted record on construction", () => {
    const id = seedSession({ agentState: "busy" });
    const m = makeMachine(id);
    expect(m.getState()).toBe("busy");
  });

  // ── Invalid transitions guarded ──────────────────────────────────────────

  it("rejects illegal transitions", () => {
    const id = seedSession();
    const m = makeMachine(id); // starting
    expect(() => m.signalDone()).toThrow(InvalidCliTransitionError);
    expect(() => m.followUp()).toThrow(InvalidCliTransitionError);
  });
});
