import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { Database, CliSessionStore } from "@fusion/core";
import { TelemetryHub } from "../../telemetry-hub.js";
import {
  droidAdapter,
  DROID_CAPABILITIES,
  buildDroidSettings,
  classifyNotification,
  mapHookPayload,
  parseHookPayload,
  classifyStop,
  DroidTranscriptTailer,
  DroidReadinessDetector,
  type DroidHookScriptRefs,
} from "../droid.js";

const SCRIPTS: DroidHookScriptRefs = {
  stopScript: "/tmp/sess/hooks/stop.sh",
  notificationScript: "/tmp/sess/hooks/notify.sh",
  sessionStartScript: "/tmp/sess/hooks/start.sh",
};

describe("droidAdapter — capabilities + identity", () => {
  it("declares the native tier capability flags", () => {
    expect(droidAdapter.id).toBe("droid");
    expect(droidAdapter.capabilities).toEqual({
      nativeDone: true,
      nativeWaiting: true,
      transcriptSource: "jsonl",
      supportsResume: true,
    });
    expect(DROID_CAPABILITIES).toEqual(droidAdapter.capabilities);
  });
});

describe("droidAdapter — buildLaunch + settings", () => {
  it("launches bare `droid` with no hook scripts", () => {
    const spec = droidAdapter.buildLaunch({ settings: {}, posture: null });
    expect(spec.command).toBe("droid");
    expect(spec.args).toEqual([]);
  });

  it("builds the Claude-style hooks settings for the core events", () => {
    const doc = buildDroidSettings(SCRIPTS);
    expect(Object.keys(doc.hooks).sort()).toEqual(["Notification", "SessionStart", "Stop"]);
    expect(doc.hooks.Stop[0].hooks[0].command).toBe(SCRIPTS.stopScript);
    expect(doc.hooks.Notification[0].hooks[0].command).toBe(SCRIPTS.notificationScript);
  });

  it("registers tool-activity hooks only when a toolActivityScript is provided", () => {
    const doc = buildDroidSettings({ ...SCRIPTS, toolActivityScript: "/tmp/act.sh" });
    expect(doc.hooks.PreToolUse[0].hooks[0].command).toBe("/tmp/act.sh");
    expect(doc.hooks.PostToolUse).toBeDefined();
  });

  it("inlines settings via --settings when no settingsPath given", () => {
    const spec = droidAdapter.buildLaunch({ settings: { hookScripts: SCRIPTS }, posture: null });
    const idx = spec.args.indexOf("--settings");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(spec.args[idx + 1]).hooks.Stop[0].hooks[0].command).toBe(SCRIPTS.stopScript);
  });

  it("emits `--auto high` ONLY when posture.autoApprove is true", () => {
    const off = droidAdapter.buildLaunch({ settings: {}, posture: { autoApprove: false } });
    expect(off.args).not.toContain("--auto");
    const on = droidAdapter.buildLaunch({ settings: {}, posture: { autoApprove: true } });
    expect(on.args).toEqual(expect.arrayContaining(["--auto", "high"]));
  });

  it("env allowlist excludes FUSION_* / service credentials", () => {
    const allow = droidAdapter.buildEnvAllowlist({ settings: {}, posture: null });
    expect(allow).toContain("PATH");
    expect(allow).toContain("FACTORY_API_KEY");
    expect(allow.some((k) => k.startsWith("FUSION_"))).toBe(false);
  });
});

describe("droidAdapter — buildResume (the `-r` footgun)", () => {
  it("interactive: `droid --resume <id>`", () => {
    const spec = droidAdapter.buildResume!({
      settings: {},
      posture: null,
      nativeSessionId: "sess-1",
    });
    expect(spec.command).toBe("droid");
    expect(spec.args.slice(0, 2)).toEqual(["--resume", "sess-1"]);
  });

  it("headless exec: `droid exec -s <id>` and NEVER a bare `-r`", () => {
    const spec = droidAdapter.buildResume!({
      settings: { execMode: true } as never,
      posture: null,
      nativeSessionId: "sess-2",
    });
    expect(spec.args.slice(0, 3)).toEqual(["exec", "-s", "sess-2"]);
    // THE FOOTGUN: in exec mode `-r` means --reasoning-effort, not resume.
    expect(spec.args).not.toContain("-r");
  });

  it("headless exec NEVER emits `-r` even with model + autoApprove", () => {
    const spec = droidAdapter.buildResume!({
      settings: { execMode: true, model: "claude-opus-4-7" } as never,
      posture: { autoApprove: true },
      nativeSessionId: "sess-3",
    });
    expect(spec.args).not.toContain("-r");
    expect(spec.args).toContain("-s");
    expect(spec.args).toEqual(expect.arrayContaining(["--model", "claude-opus-4-7"]));
  });
});

describe("droidAdapter — formatInjection", () => {
  it("appends a trailing \\r submit, no doubling", () => {
    expect(droidAdapter.formatInjection("hello", { bracketedPasteActive: false })).toEqual({
      payload: "hello\r",
    });
    expect(droidAdapter.formatInjection("hi\r", { bracketedPasteActive: true })).toEqual({
      payload: "hi\r",
    });
  });
});

describe("classifyNotification — the conflated Notification discriminator", () => {
  it("classifies permission wording as permission_request", () => {
    expect(classifyNotification("Droid wants to run `npm test` — approve?")).toBe(
      "permission_request",
    );
    expect(classifyNotification("Permission needed to edit file")).toBe("permission_request");
  });

  it("classifies idle wording as idle_prompt", () => {
    expect(classifyNotification("Still waiting for your input")).toBe("idle_prompt");
    expect(classifyNotification("Session has been idle for 60s")).toBe("idle_prompt");
  });

  it("defaults an ambiguous/bare ping to idle_prompt", () => {
    expect(classifyNotification("Notification")).toBe("idle_prompt");
    expect(classifyNotification(undefined)).toBe("idle_prompt");
  });

  it("permission wording wins when both are present", () => {
    expect(classifyNotification("Idle — but Droid wants to approve a command")).toBe(
      "permission_request",
    );
  });
});

describe("mapHookPayload — telemetry mapping", () => {
  it("SessionStart → sessionStart capturing session_id + transcript_path + permission_mode", () => {
    const ev = mapHookPayload({
      hook_event_name: "SessionStart",
      session_id: "S1",
      transcript_path: "/t.jsonl",
      permission_mode: "auto",
      source: "startup",
    });
    expect(ev?.kind).toBe("sessionStart");
    expect(ev?.payload?.nativeSessionId).toBe("S1");
    expect(ev?.payload?.transcriptPath).toBe("/t.jsonl");
    expect(ev?.payload?.permissionMode).toBe("auto");
  });

  it("Notification{permission} → waitingOnInput tagged permission_request", () => {
    const ev = mapHookPayload({
      hook_event_name: "Notification",
      session_id: "S1",
      message: "Droid wants to run a command — approve?",
    });
    expect(ev?.kind).toBe("waitingOnInput");
    expect((ev?.payload?.notification as Record<string, unknown>).kind).toBe("permission_request");
  });

  it("Notification{idle} → waitingOnInput tagged idle_prompt", () => {
    const ev = mapHookPayload({
      hook_event_name: "Notification",
      message: "Waiting for your input (idle 60s)",
    });
    expect(ev?.kind).toBe("waitingOnInput");
    expect((ev?.payload?.notification as Record<string, unknown>).kind).toBe("idle_prompt");
  });

  it("PreToolUse/PostToolUse → toolActivity; Stop → done", () => {
    expect(mapHookPayload({ hook_event_name: "PreToolUse", tool_name: "Bash" })?.kind).toBe(
      "toolActivity",
    );
    expect(mapHookPayload({ hook_event_name: "Stop", session_id: "S1" })?.kind).toBe("done");
  });

  it("tolerates missing fields; unknown event → null unless a session id", () => {
    expect(mapHookPayload({ hook_event_name: "Stop" })?.kind).toBe("done");
    expect(mapHookPayload({})).toBeNull();
    expect(mapHookPayload({ hook_event_name: "Weird", session_id: "S" })?.kind).toBe(
      "outputProgress",
    );
  });
});

describe("classifyStop — failure downgrade", () => {
  it("clean Stop → done; error-ish stop_reason → toolActivity", () => {
    expect(classifyStop({ hook_event_name: "Stop" }).kind).toBe("done");
    const ev = classifyStop({ hook_event_name: "Stop", stop_reason: "error_aborted" });
    expect(ev.kind).toBe("toolActivity");
    expect(ev.payload?.stopReason).toBe("error_aborted");
  });
});

describe("parseHookPayload — raw stdin parsing", () => {
  it("parses JSON and never throws", () => {
    expect(parseHookPayload('{"hook_event_name":"Stop","session_id":"S1"}')?.kind).toBe("done");
    expect(parseHookPayload("not json")).toBeNull();
  });
});

describe("DroidTranscriptTailer — incremental JSONL tail", () => {
  it("yields entries incrementally with offset tracking", () => {
    const tailer = new DroidTranscriptTailer();
    const l1 = JSON.stringify({ message: { role: "user", content: "hi" } }) + "\n";
    expect(tailer.push(l1)).toEqual([{ role: "user", text: "hi" }]);
    const l2 = JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "yo" }] } }) + "\n";
    expect(tailer.push(l2)).toEqual([{ role: "assistant", text: "yo" }]);
    expect(tailer.bytesRead).toBe(Buffer.byteLength(l1 + l2, "utf8"));
  });

  it("holds a partial line and flushes an unterminated final line", () => {
    const tailer = new DroidTranscriptTailer();
    const full = JSON.stringify({ role: "tool", content: "result" });
    expect(tailer.push(full.slice(0, 8))).toEqual([]);
    expect(tailer.push(full.slice(8))).toEqual([]);
    expect(tailer.flush()).toEqual([{ role: "tool", text: "result" }]);
  });
});

describe("DroidReadinessDetector", () => {
  it("ready on bracketed-paste enable or prompt glyph", () => {
    const a = new DroidReadinessDetector();
    expect(a.observe("loading\n")).toBe(false);
    expect(a.observe("\x1b[?2004h")).toBe(true);
    const b = new DroidReadinessDetector();
    expect(b.observe("hi\n")).toBe(false);
    expect(b.observe("\n❯ ")).toBe(true);
  });
});

describe("end-to-end via TelemetryHub: SessionStart → Notification → Stop", () => {
  let tmpDir: string;
  let db: Database;
  let store: CliSessionStore;
  let hub: TelemetryHub;
  let sessionId: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kb-droid-e2e-"));
    const fusionDir = join(tmpDir, ".fusion");
    db = new Database(fusionDir, { inMemory: true });
    db.init();
    store = new CliSessionStore(fusionDir, db);
    const rec = store.createSession({
      purpose: "execute",
      projectId: "p1",
      adapterId: "droid",
      agentState: "starting",
    });
    sessionId = rec.id;
    hub = new TelemetryHub({ store });
  });

  afterEach(async () => {
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function feed(p: Parameters<typeof mapHookPayload>[0]) {
    const ev = mapHookPayload(p);
    if (ev) hub.ingest(sessionId, ev);
  }

  it("drives ready → busy → waitingOnInput → busy → done; captures session_id", () => {
    feed({ hook_event_name: "SessionStart", session_id: "native-d", transcript_path: "/t.jsonl" });
    expect(hub.getStateMachine(sessionId)?.getState()).toBe("ready");
    expect(store.getSession(sessionId)?.nativeSessionId).toBe("native-d");

    hub.getStateMachine(sessionId)!.injectPrompt(); // ready → busy
    feed({ hook_event_name: "Notification", session_id: "native-d", message: "approve command?" });
    expect(hub.getStateMachine(sessionId)?.getState()).toBe("waitingOnInput");

    feed({ hook_event_name: "PreToolUse" }); // tolerated activity; no advance
    hub.ingest(sessionId, { kind: "busy" }); // user answered
    expect(hub.getStateMachine(sessionId)?.getState()).toBe("busy");

    feed({ hook_event_name: "Stop", session_id: "native-d" });
    expect(hub.getStateMachine(sessionId)?.getState()).toBe("done");
  });
});
