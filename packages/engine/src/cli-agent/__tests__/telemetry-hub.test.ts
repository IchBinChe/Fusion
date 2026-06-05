import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CliSessionStore, Database } from "@fusion/core";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { TelemetryHub, stripAnsiControl } from "../telemetry-hub.js";

describe("TelemetryHub", () => {
  let tmpDir: string;
  let fusionDir: string;
  let db: Database;
  let store: CliSessionStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kb-cli-hub-test-"));
    fusionDir = join(tmpDir, ".fusion");
    db = new Database(fusionDir, { inMemory: true });
    db.init();
    store = new CliSessionStore(fusionDir, db);
  });

  afterEach(async () => {
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function seed(overrides: Record<string, unknown> = {}): string {
    return store.createSession({
      purpose: "execute",
      projectId: "proj",
      adapterId: "claude-code",
      ...overrides,
    }).id;
  }

  // ── Token registry ─────────────────────────────────────────────────────────

  it("token validates only for its own session", () => {
    const a = seed({ agentState: "busy" });
    const b = seed({ agentState: "busy" });
    const hub = new TelemetryHub({ store });
    const tokenA = hub.issueToken(a);
    const tokenB = hub.issueToken(b);
    expect(hub.validateToken(a, tokenA)).toBe(true);
    expect(hub.validateToken(b, tokenB)).toBe(true);
    // Forged completion: session A presenting B's token → rejected.
    expect(hub.validateToken(a, tokenB)).toBe(false);
    expect(hub.validateToken(b, tokenA)).toBe(false);
  });

  it("tokens are high-entropy and unique per session", () => {
    const a = seed({ agentState: "busy" });
    const b = seed({ agentState: "busy" });
    const hub = new TelemetryHub({ store });
    const tokenA = hub.issueToken(a);
    const tokenB = hub.issueToken(b);
    expect(tokenA).toHaveLength(64); // 32 bytes → 64 hex
    expect(tokenA).not.toEqual(tokenB);
    expect(hub.validateToken(a, "deadbeef")).toBe(false);
    expect(hub.validateToken(a, null)).toBe(false);
  });

  it("invalidate revokes the token after session end", () => {
    const a = seed({ agentState: "busy" });
    const hub = new TelemetryHub({ store });
    const tokenA = hub.issueToken(a);
    expect(hub.validateToken(a, tokenA)).toBe(true);
    hub.invalidate(a);
    expect(hub.validateToken(a, tokenA)).toBe(false);
    expect(hub.hasSession(a)).toBe(false);
  });

  it("rebuilds only from live sessions; non-live sessions never validate after restart", () => {
    const live = seed({ agentState: "busy" });
    const dead = seed({ agentState: "done", terminationReason: "completed" });
    // First hub mints a token for the dead-in-future session while it was live...
    const hub1 = new TelemetryHub({ store });
    const staleToken = hub1.issueToken(dead);
    expect(hub1.validateToken(dead, staleToken)).toBe(true);

    // Simulate restart: a fresh hub rebuilds from the store. `dead` is no longer
    // live, so its on-disk-era token is not reconstituted.
    const hub2 = new TelemetryHub({ store });
    expect(hub2.hasSession(live)).toBe(true);
    expect(hub2.hasSession(dead)).toBe(false);
    expect(hub2.validateToken(dead, staleToken)).toBe(false);
  });

  // ── Ingestion → state routing ────────────────────────────────────────────

  it("sessionStart drives starting → ready; native session id captured", () => {
    const a = seed(); // starting
    const hub = new TelemetryHub({ store });
    hub.issueToken(a);
    hub.ingest(a, { kind: "sessionStart", payload: { nativeSessionId: "claude-xyz" } });
    expect(hub.getStateMachine(a)?.getState()).toBe("ready");
    expect(store.getSession(a)?.nativeSessionId).toBe("claude-xyz");
  });

  it("native done advances to done; idle/output never does", () => {
    const a = seed({ agentState: "busy" });
    const hub = new TelemetryHub({ store });
    hub.issueToken(a);
    hub.ingest(a, { kind: "outputProgress", payload: { text: "thinking..." } });
    hub.ingest(a, { kind: "toolActivity" });
    expect(hub.getStateMachine(a)?.getState()).toBe("busy"); // never done from activity
    hub.ingest(a, { kind: "done" });
    expect(hub.getStateMachine(a)?.getState()).toBe("done");
  });

  it("idle event surfaces a busy-equivalent idle state, never done (R20)", () => {
    const a = seed({ agentState: "busy" });
    const hub = new TelemetryHub({ store });
    hub.issueToken(a);
    hub.ingest(a, { kind: "idle" });
    expect(hub.getStateMachine(a)?.getState()).toBe("idle");
    expect(store.getSession(a)?.agentState).toBe("busy"); // persists as busy
    // Resumed output flips back to busy; never reaches done.
    hub.ingest(a, { kind: "busy" });
    expect(hub.getStateMachine(a)?.getState()).toBe("busy");
  });

  it("AE2: waitingOnInput dispatches notification, state does not advance/fail", () => {
    const a = seed({ agentState: "busy" });
    const dispatched: unknown[] = [];
    const hub = new TelemetryHub({
      store,
      onNotification: (info) => dispatched.push(info),
    });
    hub.issueToken(a);
    hub.ingest(a, {
      kind: "waitingOnInput",
      payload: { notification: { type: "permission", tool: "Bash" } },
    });
    expect(hub.getStateMachine(a)?.getState()).toBe("waitingOnInput");
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      sessionId: a,
      notification: { type: "permission", tool: "Bash" },
    });
  });

  it("ingest on unknown / non-live session is a no-op, not a crash", () => {
    const hub = new TelemetryHub({ store });
    expect(() => hub.ingest("nope", { kind: "done" })).not.toThrow();
    expect(hub.ingest("nope", { kind: "done" })).toBeUndefined();
  });

  // ── Two turns through one handler: latch reset ───────────────────────────

  it("per-turn event budget resets on a new busy turn", () => {
    const a = seed({ agentState: "busy" });
    const hub = new TelemetryHub({ store, maxEventsPerTurn: 2 });
    hub.issueToken(a);
    // Turn 1: budget = 2. Third event dropped.
    expect(hub.ingest(a, { kind: "outputProgress", payload: { text: "a" } })).toBeDefined();
    expect(hub.ingest(a, { kind: "outputProgress", payload: { text: "b" } })).toBeDefined();
    expect(hub.ingest(a, { kind: "outputProgress", payload: { text: "c" } })).toBeUndefined();
    // A `busy` event begins a fresh turn → budget resets (the busy event itself
    // consumes one slot, then there is room again).
    hub.ingest(a, { kind: "busy" });
    expect(hub.ingest(a, { kind: "outputProgress", payload: { text: "d" } })).toBeDefined();
  });

  // ── Bounding: oversized event capped ─────────────────────────────────────

  it("oversized event text is capped", () => {
    const a = seed({ agentState: "busy" });
    const hub = new TelemetryHub({ store, maxEventChars: 50, chunkCarryChars: 0 });
    hub.issueToken(a);
    // Plain prose (no secret-looking runs) so redaction doesn't collapse it
    // before the size cap is exercised.
    const big = "lorem ipsum ".repeat(2000);
    const out = hub.ingest(a, { kind: "outputProgress", payload: { text: big } });
    expect(out?.text?.length).toBe(50);
    expect(out?.truncated).toBe(true);
  });

  // ── ANSI noise stripped before pattern matching ──────────────────────────

  it("strips ANSI / control sequences before pattern matching", () => {
    expect(stripAnsiControl("do\x1b[1mne\x1b[0m")).toBe("done");
    expect(stripAnsiControl("clean")).toBe("clean");
    const a = seed({ agentState: "busy" });
    const hub = new TelemetryHub({ store, chunkCarryChars: 0 });
    hub.issueToken(a);
    const out = hub.ingest(a, {
      kind: "transcript",
      payload: { text: "\x1b[32mhello\x1b[0m \x1b[1mworld\x1b[0m" },
    });
    expect(out?.text).toBe("hello world");
  });

  // ── Secret redaction (incl. cross-chunk boundary) ────────────────────────

  it("redacts secrets within a single chunk", () => {
    const a = seed({ agentState: "busy" });
    const hub = new TelemetryHub({ store, chunkCarryChars: 0 });
    hub.issueToken(a);
    const out = hub.ingest(a, {
      kind: "transcript",
      payload: { text: "export API_KEY=sk-abcdef0123456789abcdef0123" },
    });
    expect(out?.text).not.toContain("sk-abcdef0123456789abcdef0123");
    expect(out?.text).toContain("[REDACTED]");
  });

  it("redacts a secret spanning a chunk boundary", () => {
    const a = seed({ agentState: "busy" });
    // Generous carry so the boundary prefix is held and joined with the next chunk.
    const hub = new TelemetryHub({ store, chunkCarryChars: 64 });
    hub.issueToken(a);
    // Prefix "token=" arrives in chunk 1 (held in carry), value in chunk 2.
    const out1 = hub.ingest(a, { kind: "transcript", payload: { text: "the token=" } });
    const out2 = hub.ingest(a, {
      kind: "transcript",
      payload: { text: "sk-abcdef0123456789abcdef0123 done" },
    });
    const combined = (out1?.text ?? "") + (out2?.text ?? "") + (hub.flush(a) ?? "");
    expect(combined).not.toContain("sk-abcdef0123456789abcdef0123");
    expect(combined).toContain("[REDACTED]");
  });

  it("flush emits the held tail redacted on session end", () => {
    const a = seed({ agentState: "busy" });
    const hub = new TelemetryHub({ store, chunkCarryChars: 64 });
    hub.issueToken(a);
    hub.ingest(a, { kind: "transcript", payload: { text: "trailing secret=sk-zzzz0123456789abcd0123" } });
    const flushed = hub.flush(a) ?? "";
    expect(flushed).not.toContain("sk-zzzz0123456789abcd0123");
  });

  // ── Sanitized-event tap (U12 chat transcript seam) ──────────────────────────

  it("onEvent tap receives sanitized events after routing (constructor option)", () => {
    const a = seed({ agentState: "busy" });
    const seen: Array<{ sessionId: string; kind: string; text?: string }> = [];
    const hub = new TelemetryHub({
      store,
      // No carry window so transcript text emits in the same event (the carry
      // behavior is exercised by the redaction tests above).
      chunkCarryChars: 0,
      onEvent: (sessionId, event) => seen.push({ sessionId, kind: event.kind, text: event.text }),
    });
    hub.issueToken(a);
    hub.ingest(a, { kind: "busy", payload: {} });
    hub.ingest(a, { kind: "transcript", payload: { text: "hello world" } });
    hub.ingest(a, { kind: "done", payload: {} });
    expect(seen.map((e) => e.kind)).toEqual(["busy", "transcript", "done"]);
    expect(seen.every((e) => e.sessionId === a)).toBe(true);
    // Tap sees the SANITIZED text, not the raw payload.
    expect(seen[1].text).toContain("hello world");
  });

  it("onEvent tap is settable post-construction and clearable", () => {
    const a = seed({ agentState: "busy" });
    const hub = new TelemetryHub({ store });
    hub.issueToken(a);
    const seen: string[] = [];
    hub.setEventListener((_sessionId, event) => seen.push(event.kind));
    hub.ingest(a, { kind: "busy", payload: {} });
    hub.setEventListener(undefined);
    hub.ingest(a, { kind: "done", payload: {} });
    expect(seen).toEqual(["busy"]); // only the event ingested while the listener was set
  });

  it("a throwing onEvent listener never breaks ingest", () => {
    const a = seed({ agentState: "busy" });
    const hub = new TelemetryHub({
      store,
      chunkCarryChars: 0,
      onEvent: () => {
        throw new Error("listener boom");
      },
    });
    hub.issueToken(a);
    // ingest still returns the sanitized event despite the throwing tap.
    const out = hub.ingest(a, { kind: "transcript", payload: { text: "still here" } });
    expect(out?.text).toContain("still here");
  });
});
