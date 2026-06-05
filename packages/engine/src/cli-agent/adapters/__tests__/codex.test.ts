import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { Database, CliSessionStore } from "@fusion/core";
import { TelemetryHub, type TelemetryEvent } from "../../telemetry-hub.js";
import {
  codexAdapter,
  CODEX_CAPABILITIES,
  buildNotifyOverrideArg,
  codexSessionHomeLayout,
  mapNotifyPayload,
  parseNotifyPayload,
  CodexWaitingAnalyzer,
  CodexRolloutTailer,
  CodexReadinessDetector,
  findRolloutPath,
  type DirentLike,
} from "../codex.js";

// ── fake fs for findRolloutPath ────────────────────────────────────────────────

function dir(name: string): DirentLike {
  return { name, isDirectory: () => true };
}
function file(name: string): DirentLike {
  return { name, isDirectory: () => false };
}

describe("codexAdapter — capabilities + identity", () => {
  it("declares the HYBRID tier capability flags (nativeWaiting OFF)", () => {
    expect(codexAdapter.id).toBe("codex");
    expect(codexAdapter.capabilities).toEqual({
      nativeDone: true,
      nativeWaiting: false,
      transcriptSource: "jsonl",
      supportsResume: true,
    });
    expect(CODEX_CAPABILITIES).toEqual(codexAdapter.capabilities);
  });
});

describe("codexAdapter — buildLaunch + notify override", () => {
  it("launches bare `codex` with no notify program", () => {
    const spec = codexAdapter.buildLaunch({ settings: {}, posture: null });
    expect(spec.command).toBe("codex");
    expect(spec.args).toEqual([]);
  });

  it("appends `-c notify=[...]` when a session-scoped notify program is set", () => {
    const spec = codexAdapter.buildLaunch({
      settings: { notifyProgram: "/tmp/sess/notify.sh" },
      posture: null,
    });
    const idx = spec.args.indexOf("-c");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(spec.args[idx + 1]).toBe('notify=["/tmp/sess/notify.sh"]');
  });

  it("buildNotifyOverrideArg returns empty for a missing program", () => {
    expect(buildNotifyOverrideArg(undefined)).toEqual([]);
    expect(buildNotifyOverrideArg("")).toEqual([]);
  });

  it("sets the model via `-c model=` so it composes with notify", () => {
    const spec = codexAdapter.buildLaunch({
      settings: { model: "gpt-5.4", notifyProgram: "/n.sh" },
      posture: null,
    });
    expect(spec.args).toContain("model=\"gpt-5.4\"");
    expect(spec.args).toContain('notify=["/n.sh"]');
  });

  it("emits the privileged bypass ONLY when posture.autoApprove is true", () => {
    const off = codexAdapter.buildLaunch({ settings: {}, posture: { autoApprove: false } });
    expect(off.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    const on = codexAdapter.buildLaunch({ settings: {}, posture: { autoApprove: true } });
    expect(on.args).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("env allowlist includes CODEX_HOME, excludes FUSION_* / service creds", () => {
    const allow = codexAdapter.buildEnvAllowlist({ settings: {}, posture: null });
    expect(allow).toContain("PATH");
    expect(allow).toContain("CODEX_HOME");
    expect(allow.some((k) => k.startsWith("FUSION_"))).toBe(false);
  });

  it("codexSessionHomeLayout describes the layered scratch CODEX_HOME", () => {
    const layout = codexSessionHomeLayout("/tmp/sess/codex-home");
    expect(layout).toEqual({
      home: "/tmp/sess/codex-home",
      configPath: "/tmp/sess/codex-home/config.toml",
      authPath: "/tmp/sess/codex-home/auth.json",
    });
  });
});

describe("codexAdapter — buildResume", () => {
  it("produces `codex resume <thread-id>` (AE3)", () => {
    const spec = codexAdapter.buildResume!({
      settings: {},
      posture: null,
      nativeSessionId: "thread-abc",
    });
    expect(spec.command).toBe("codex");
    expect(spec.args.slice(0, 2)).toEqual(["resume", "thread-abc"]);
  });

  it("re-applies notify + model on resume", () => {
    const spec = codexAdapter.buildResume!({
      settings: { notifyProgram: "/n.sh", model: "gpt-5.4" },
      posture: { autoApprove: true },
      nativeSessionId: "t9",
    });
    expect(spec.args.slice(0, 2)).toEqual(["resume", "t9"]);
    expect(spec.args).toContain('notify=["/n.sh"]');
    expect(spec.args).toContain("--dangerously-bypass-approvals-and-sandbox");
  });
});

describe("codexAdapter — formatInjection", () => {
  it("appends a trailing \\r submit", () => {
    expect(codexAdapter.formatInjection("hello", { bracketedPasteActive: false })).toEqual({
      payload: "hello\r",
    });
  });
  it("does not double the trailing \\r", () => {
    expect(codexAdapter.formatInjection("hi\r", { bracketedPasteActive: true })).toEqual({
      payload: "hi\r",
    });
  });
});

describe("mapNotifyPayload — native done via notify", () => {
  it("agent-turn-complete → done, capturing thread-id as nativeSessionId", () => {
    const ev = mapNotifyPayload({
      type: "agent-turn-complete",
      "thread-id": "T1",
      "turn-id": "U1",
      cwd: "/repo",
      "last-assistant-message": "all done",
    });
    expect(ev?.kind).toBe("done");
    expect(ev?.payload?.nativeSessionId).toBe("T1");
    expect(ev?.payload?.turnId).toBe("U1");
    expect(ev?.payload?.lastAssistantMessage).toBe("all done");
    expect(ev?.payload?.cwd).toBe("/repo");
  });

  it("tolerates snake_case / camelCase key spellings", () => {
    expect(mapNotifyPayload({ type: "agent-turn-complete", thread_id: "T2" })?.payload?.nativeSessionId).toBe(
      "T2",
    );
    expect(mapNotifyPayload({ type: "agent-turn-complete", threadId: "T3" })?.payload?.nativeSessionId).toBe(
      "T3",
    );
  });

  it("ignores non-turn-complete payloads", () => {
    expect(mapNotifyPayload({ type: "something-else", "thread-id": "X" })).toBeNull();
    expect(mapNotifyPayload({})).toBeNull();
  });

  it("parseNotifyPayload parses the raw JSON arg and never throws", () => {
    expect(parseNotifyPayload('{"type":"agent-turn-complete","thread-id":"Z"}')?.kind).toBe("done");
    expect(parseNotifyPayload("not json")).toBeNull();
    expect(parseNotifyPayload("[]")).toBeNull();
  });
});

describe("CodexWaitingAnalyzer — heuristic waiting detection (hybrid fallback)", () => {
  function collect(): { events: TelemetryEvent[]; analyzer: CodexWaitingAnalyzer } {
    const events: TelemetryEvent[] = [];
    const analyzer = new CodexWaitingAnalyzer({ emit: (e) => events.push(e) });
    return { events, analyzer };
  }

  it("detects an approval prompt buried in ANSI noise → waitingOnInput", () => {
    const { events, analyzer } = collect();
    // Approval menu wrapped in ANSI color codes (the "noise included" scenario).
    const ansi =
      "\x1b[1m\x1b[33mApply this patch?\x1b[0m\n" +
      "\x1b[2m1. Yes\x1b[0m\n\x1b[2m2. No\x1b[0m\n";
    analyzer.observe(ansi);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("waitingOnInput");
    expect((events[0].payload?.notification as Record<string, unknown>).kind).toBe(
      "approval_prompt",
    );
    expect((events[0].payload?.notification as Record<string, unknown>).source).toBe("heuristic");
  });

  it("detects a bare y/n prompt at the trailing edge", () => {
    const { events, analyzer } = collect();
    analyzer.observe("Run command `rm -rf build`? (y/n) ");
    expect(events.map((e) => e.kind)).toEqual(["waitingOnInput"]);
  });

  it("detects an idle 'enter to send' composer marker → idle_prompt", () => {
    const { events, analyzer } = collect();
    analyzer.observe("\x1b[90m enter to send \x1b[0m");
    expect(events).toHaveLength(1);
    expect((events[0].payload?.notification as Record<string, unknown>).kind).toBe("idle_prompt");
  });

  it("a working/spinner marker OVERRIDES a prompt (still busy)", () => {
    const { events, analyzer } = collect();
    analyzer.observe("Working… esc to interrupt  y/n");
    expect(events).toHaveLength(0);
  });

  it("de-dupes a repeated prompt and re-arms on fresh non-prompt output", () => {
    const { events, analyzer } = collect();
    analyzer.observe("Approve? (y/n) ");
    analyzer.observe("Approve? (y/n) "); // still waiting → no second emit
    expect(events).toHaveLength(1);
    analyzer.observe("\nreading files...\n"); // fresh output re-arms
    analyzer.observe("Approve? (y/n) ");
    expect(events).toHaveLength(2);
  });
});

describe("findRolloutPath — probe, don't hardcode the dated layout", () => {
  it("finds rollout-<...>-<thread-id>.jsonl under a dated subtree", () => {
    const fs = {
      readdirSync(p: string): DirentLike[] {
        if (p === "/sessions") return [dir("2026")];
        if (p === "/sessions/2026") return [dir("05")];
        if (p === "/sessions/2026/05") return [dir("03")];
        if (p === "/sessions/2026/05/03") {
          return [
            file("rollout-2026-05-03T17-03-33-other.jsonl"),
            file("rollout-2026-05-03T20-08-32-THREAD42.jsonl"),
          ];
        }
        return [];
      },
    };
    expect(findRolloutPath("/sessions", "THREAD42", fs)).toBe(
      "/sessions/2026/05/03/rollout-2026-05-03T20-08-32-THREAD42.jsonl",
    );
  });

  it("returns null when no file matches / dir missing (tolerant)", () => {
    const fs = {
      readdirSync(p: string): DirentLike[] {
        if (p === "/sessions") return [file("rollout-x-AAA.jsonl")];
        throw new Error("ENOENT");
      },
    };
    expect(findRolloutPath("/sessions", "ZZZ", fs)).toBeNull();
  });
});

describe("CodexRolloutTailer — incremental rollout JSONL tail", () => {
  it("yields only response_item message rows, incrementally, with offset", () => {
    const tailer = new CodexRolloutTailer();
    const meta =
      JSON.stringify({ type: "session_meta", payload: { id: "T1", cwd: "/r" } }) + "\n";
    const started =
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }) + "\n";
    const msg =
      JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      }) + "\n";

    const first = tailer.push(meta + started); // no chat rows
    expect(first).toEqual([]);
    const second = tailer.push(msg);
    expect(second).toEqual([{ role: "user", text: "hi" }]);
    expect(tailer.bytesRead).toBe(Buffer.byteLength(meta + started + msg, "utf8"));
  });

  it("holds a partial trailing line until its newline arrives", () => {
    const tailer = new CodexRolloutTailer();
    const line = JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
    });
    expect(tailer.push(line.slice(0, 20))).toEqual([]);
    expect(tailer.push(line.slice(20) + "\n")).toEqual([{ role: "assistant", text: "ok" }]);
  });

  it("skips unparseable lines without throwing", () => {
    const tailer = new CodexRolloutTailer();
    expect(tailer.push("{bad}\n\n")).toEqual([]);
  });
});

describe("CodexReadinessDetector", () => {
  it("becomes ready on bracketed-paste enable", () => {
    const d = new CodexReadinessDetector();
    expect(d.observe("loading\n")).toBe(false);
    expect(d.observe("\x1b[?2004h")).toBe(true);
    expect(d.observe("x")).toBe(true); // latches
  });
  it("falls back to a composer prompt glyph", () => {
    const d = new CodexReadinessDetector();
    expect(d.observe("welcome\n")).toBe(false);
    expect(d.observe("\n❯")).toBe(true);
  });
});

describe("end-to-end via TelemetryHub: notify done + heuristic waiting", () => {
  let tmpDir: string;
  let db: Database;
  let store: CliSessionStore;
  let hub: TelemetryHub;
  let sessionId: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kb-codex-e2e-"));
    const fusionDir = join(tmpDir, ".fusion");
    db = new Database(fusionDir, { inMemory: true });
    db.init();
    store = new CliSessionStore(fusionDir, db);
    const rec = store.createSession({
      purpose: "execute",
      projectId: "p1",
      adapterId: "codex",
      agentState: "starting",
    });
    sessionId = rec.id;
    hub = new TelemetryHub({ store });
  });

  afterEach(async () => {
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("notify agent-turn-complete drives busy → done and captures thread-id", () => {
    const machine = hub.getStateMachine(sessionId)!;
    machine.markReady();
    machine.injectPrompt(); // ready → busy

    const waiting: TelemetryEvent[] = [];
    const analyzer = new CodexWaitingAnalyzer({ emit: (e) => waiting.push(e) });
    analyzer.observe("Approve patch? (y/n) ");
    for (const e of waiting) hub.ingest(sessionId, e);
    expect(machine.getState()).toBe("waitingOnInput");

    // user answers → busy again (hub `busy` route)
    hub.ingest(sessionId, { kind: "busy" });
    expect(machine.getState()).toBe("busy");

    const done = parseNotifyPayload('{"type":"agent-turn-complete","thread-id":"native-T"}');
    hub.ingest(sessionId, done!);
    expect(machine.getState()).toBe("done");
    expect(store.getSession(sessionId)?.nativeSessionId).toBe("native-T");
  });
});
