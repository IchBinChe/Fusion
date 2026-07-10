import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GrokStreamProcess } from "../cli-stream.js";
import { GrokRuntimeAdapter } from "../runtime-adapter.js";

/*
FNXC:GrokCli 2026-07-10-11:05:
FN-7790: adapter tests are pinned to the operator-verified xAI Grok Build TUI stream (`thought`/`text`/`end` with `data`). They intentionally avoid a live binary in CI but exercise the same spawn seam and lifecycle diagnostics that previously hid the wrong `--prompt`/`--format json` contract behind fake superagent-ai fixtures.
*/

function makeFakeProc(): { proc: GrokStreamProcess; stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> } {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const kill = vi.fn();
  const proc = Object.assign(emitter, { stdout, stderr, kill }) as unknown as GrokStreamProcess;
  return { proc, stdout, stderr, kill };
}

function closeProc(proc: GrokStreamProcess, code = 0, signal: NodeJS.Signals | null = null): void {
  proc.emit("close", code, signal);
}

describe("GrokRuntimeAdapter", () => {
  it("creates a session with default model fallback", async () => {
    const adapter = new GrokRuntimeAdapter();
    const result = await adapter.createSession({ systemPrompt: "sys" });
    expect(result.session.model).toBe("grok/default");
    expect(result.session.systemPrompt).toBe("sys");
  });

  it("passes the normalized selected model to the CLI spawn seam", async () => {
    const { proc } = makeFakeProc();
    const spawn = vi.fn().mockReturnValue(proc);
    const adapter = new GrokRuntimeAdapter({ spawn });
    const { session } = await adapter.createSession({ defaultModelId: "grok-cli/grok-4.5" });

    const promise = adapter.promptWithFallback(session, "hello grok");
    closeProc(proc);
    await promise;

    expect(session.model).toBe("grok-4.5");
    expect(spawn).toHaveBeenCalledWith("grok", "hello grok", expect.objectContaining({ model: "grok-4.5" }));
  });

  it("omits -m for the no-model grok/default fallback", async () => {
    const { proc } = makeFakeProc();
    const spawn = vi.fn().mockReturnValue(proc);
    const adapter = new GrokRuntimeAdapter({ spawn });
    const { session } = await adapter.createSession({});

    const promise = adapter.promptWithFallback(session, "hello grok");
    closeProc(proc);
    await promise;

    expect(session.model).toBe("grok/default");
    expect(spawn).toHaveBeenCalledWith("grok", "hello grok", expect.objectContaining({ model: undefined }));
  });

  it("bridges real xAI thought/text/end events and persists assistant content", async () => {
    const { proc, stdout } = makeFakeProc();
    const spawn = vi.fn().mockReturnValue(proc);
    const adapter = new GrokRuntimeAdapter({ spawn });
    const onText = vi.fn();
    const onThinking = vi.fn();
    const { session } = await adapter.createSession({ onText, onThinking });

    const promise = adapter.promptWithFallback(session, "hello grok");
    stdout.write(`${JSON.stringify({ type: "thought", data: "Thinking" })}\n`);
    stdout.write(`${JSON.stringify({ type: "text", data: "Hel" })}\n`);
    stdout.write(`${JSON.stringify({ type: "text", data: "lo" })}\n`);
    stdout.write(`${JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "session-1", requestId: "request-1" })}\n`);
    closeProc(proc);
    await promise;

    expect(onThinking.mock.calls.map((c) => c[0])).toEqual(["Thinking"]);
    expect(onText.mock.calls.map((c) => c[0])).toEqual(["Hel", "lo"]);
    expect(session.sessionId).toBe("session-1");
    expect(session.state.messages).toContainEqual({ role: "assistant", content: "Hello" });
  });

  it("bridges a single text event without thought events", async () => {
    const { proc, stdout } = makeFakeProc();
    const spawn = vi.fn().mockReturnValue(proc);
    const adapter = new GrokRuntimeAdapter({ spawn });
    const onText = vi.fn();
    const { session } = await adapter.createSession({ onText });

    const promise = adapter.promptWithFallback(session, "one word");
    stdout.write(`${JSON.stringify({ type: "text", data: "Hello" })}\n`);
    stdout.write(`${JSON.stringify({ type: "end", stopReason: "EndTurn" })}\n`);
    closeProc(proc);
    await promise;

    expect(onText).toHaveBeenCalledWith("Hello");
    expect(session.state.messages).toContainEqual({ role: "assistant", content: "Hello" });
  });

  it("skips malformed, non-JSON, and legacy wrong-product lines without callbacks", async () => {
    const { proc, stdout } = makeFakeProc();
    const spawn = vi.fn().mockReturnValue(proc);
    const adapter = new GrokRuntimeAdapter({ spawn });
    const onText = vi.fn();
    const onThinking = vi.fn();
    const onToolStart = vi.fn();
    const { session } = await adapter.createSession({ onText, onThinking, onToolStart });

    const promise = adapter.promptWithFallback(session, "hi");
    stdout.write("[SandboxDebug] booting\n");
    stdout.write("{not valid json\n");
    stdout.write(`${JSON.stringify({ type: "tool_use", toolCall: {}, toolResult: {} })}\n`);
    stdout.write(`${JSON.stringify({ type: "end", stopReason: "EndTurn" })}\n`);
    closeProc(proc);
    await promise;

    expect(onText).not.toHaveBeenCalled();
    expect(onThinking).not.toHaveBeenCalled();
    expect(onToolStart).not.toHaveBeenCalled();
    expect(session.state.errorMessage).toBeUndefined();
  });

  it("resolves (never rejects) when the subprocess emits an error and records the diagnostic", async () => {
    const { proc } = makeFakeProc();
    const spawn = vi.fn().mockReturnValue(proc);
    const adapter = new GrokRuntimeAdapter({ spawn });
    const { session } = await adapter.createSession({});

    const promise = adapter.promptWithFallback(session, "hi");
    proc.emit("error", new Error("ENOENT"));

    await expect(promise).resolves.toBeUndefined();
    expect(session.state.errorMessage).toBe("Grok CLI process error: ENOENT");
  });

  it("waits for child close after stdout ends so fatal stderr becomes the chat diagnostic", async () => {
    const { proc, stdout, stderr } = makeFakeProc();
    const spawn = vi.fn().mockReturnValue(proc);
    const adapter = new GrokRuntimeAdapter({ spawn });
    const { session } = await adapter.createSession({});

    const promise = adapter.promptWithFallback(session, "hi");
    let resolved = false;
    void promise.then(() => {
      resolved = true;
    });

    stdout.end();
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    stderr.write("error: invalid model 'grok-unknown'\n");
    closeProc(proc, 1);
    await promise;

    expect(session.state.errorMessage).toBe("Grok CLI failed (code 1): error: invalid model 'grok-unknown'");
  });

  it("records a concrete diagnostic for non-zero exits with no stderr", async () => {
    const { proc, stdout } = makeFakeProc();
    const spawn = vi.fn().mockReturnValue(proc);
    const adapter = new GrokRuntimeAdapter({ spawn });
    const { session } = await adapter.createSession({});

    const promise = adapter.promptWithFallback(session, "hi");
    stdout.end();
    closeProc(proc, 2);
    await promise;

    expect(session.state.errorMessage).toBe("Grok CLI failed with code 2 and no stderr output.");
  });

  it("records a concrete diagnostic for code-0 exits with zero NDJSON output", async () => {
    const { proc, stdout } = makeFakeProc();
    const spawn = vi.fn().mockReturnValue(proc);
    const adapter = new GrokRuntimeAdapter({ spawn });
    const onText = vi.fn();
    const { session } = await adapter.createSession({ onText });

    const promise = adapter.promptWithFallback(session, "hi");
    stdout.end();
    closeProc(proc, 0);
    await promise;

    expect(session.state.errorMessage).toBe(
      "Grok CLI produced no NDJSON output for a headless prompt; this usually means the binary on PATH is not xAI's supported Grok Build TUI headless implementation, did not recognize -p/--output-format streaming-json, or exited interactive mode immediately after stdin EOF.",
    );
    expect(onText).toHaveBeenCalledWith(session.state.errorMessage);
    expect(session.state.messages).toContainEqual({ role: "assistant", content: session.state.errorMessage });
  });

  it("records a concrete diagnostic for code-0 exits with non-NDJSON stdout only", async () => {
    const { proc, stdout } = makeFakeProc();
    const spawn = vi.fn().mockReturnValue(proc);
    const adapter = new GrokRuntimeAdapter({ spawn });
    const onText = vi.fn();
    const { session } = await adapter.createSession({ onText });

    const promise = adapter.promptWithFallback(session, "hi");
    stdout.write("Welcome to grok interactive mode\n");
    stdout.end();
    closeProc(proc, 0);
    await promise;

    expect(session.state.errorMessage).toBe(
      "Grok CLI produced stdout but no NDJSON events for a headless prompt; first line: Welcome to grok interactive mode",
    );
    expect(onText).toHaveBeenCalledWith(session.state.errorMessage);
  });

  it("keeps a clean end event with no assistant text silent", async () => {
    const { proc, stdout } = makeFakeProc();
    const spawn = vi.fn().mockReturnValue(proc);
    const adapter = new GrokRuntimeAdapter({ spawn });
    const onText = vi.fn();
    const { session } = await adapter.createSession({ onText });

    const promise = adapter.promptWithFallback(session, "hi");
    stdout.write(`${JSON.stringify({ type: "thought", data: "No answer needed" })}\n`);
    stdout.write(`${JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "session-empty" })}\n`);
    closeProc(proc, 0);
    await promise;

    expect(onText).not.toHaveBeenCalled();
    expect(session.state.errorMessage).toBeUndefined();
    expect(session.state.messages).not.toContainEqual(expect.objectContaining({ role: "assistant" }));
    expect(session.sessionId).toBe("session-empty");
  });

  it("does not turn a successful text response into an error when stderr is noisy", async () => {
    const { proc, stdout, stderr } = makeFakeProc();
    const spawn = vi.fn().mockReturnValue(proc);
    const adapter = new GrokRuntimeAdapter({ spawn });
    const onText = vi.fn();
    const { session } = await adapter.createSession({ onText });

    const promise = adapter.promptWithFallback(session, "hi");
    stdout.write(`${JSON.stringify({ type: "text", data: "answer" })}\n`);
    stderr.write("debug noise\n");
    closeProc(proc, 1);
    await promise;

    expect(onText).toHaveBeenCalledWith("answer");
    expect(session.state.errorMessage).toBeUndefined();
  });

  it("resolves on subprocess close rather than the end event alone", async () => {
    const { proc, stdout } = makeFakeProc();
    const spawn = vi.fn().mockReturnValue(proc);
    const adapter = new GrokRuntimeAdapter({ spawn });
    const { session } = await adapter.createSession({});

    const promise = adapter.promptWithFallback(session, "hi");
    let resolved = false;
    void promise.then(() => {
      resolved = true;
    });

    stdout.write(`${JSON.stringify({ type: "end", stopReason: "EndTurn" })}\n`);
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    closeProc(proc, 0);
    await promise;
    expect(resolved).toBe(true);
  });

  describe("lifecycle timeouts (fake timers)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("kills the subprocess and resolves if no stdout line arrives within the cold-start ceiling", async () => {
      const { proc, kill } = makeFakeProc();
      const spawn = vi.fn().mockReturnValue(proc);
      const adapter = new GrokRuntimeAdapter({ spawn });
      const { session } = await adapter.createSession({});

      const promise = adapter.promptWithFallback(session, "hi");
      await vi.advanceTimersByTimeAsync(60_000);

      await promise;
      expect(kill).toHaveBeenCalledWith("SIGKILL");
    });
  });

  it("resolves without throwing if the injected spawn function throws synchronously and records the diagnostic", async () => {
    const spawn = vi.fn().mockImplementation(() => {
      throw new Error("spawn ENOENT");
    });
    const adapter = new GrokRuntimeAdapter({ spawn });
    const { session } = await adapter.createSession({});

    await expect(adapter.promptWithFallback(session, "hi")).resolves.toBeUndefined();
    expect(session.state.errorMessage).toBe("Grok CLI spawn failed: spawn ENOENT");
  });

  it("describeModel formats grok prefix", () => {
    const adapter = new GrokRuntimeAdapter();
    expect(adapter.describeModel({ model: "grok/pro" } as never)).toBe("grok/grok/pro");
  });
});
