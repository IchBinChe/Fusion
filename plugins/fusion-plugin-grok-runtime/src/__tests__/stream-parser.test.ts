import { describe, expect, it } from "vitest";
import { parseLine } from "../stream-parser.js";

/*
FNXC:GrokCli 2026-07-09-00:00:
FN-7722: fixture lines below are copied verbatim in shape from upstream
grok-cli's `src/headless/output.test.ts` (the authoritative fixture-level
confirmation of the JSONL emitter's output), not invented. See
docs/grok-cli-contract.md for the full verified schema.
*/

describe("parseLine (Grok CLI NDJSON)", () => {
  it("parses a step_start event", () => {
    const line = JSON.stringify({ type: "step_start", sessionID: "sess-1", stepNumber: 1, timestamp: 100 });
    expect(parseLine(line)).toEqual({ type: "step_start", sessionID: "sess-1", stepNumber: 1, timestamp: 100 });
  });

  it("parses a text delta event", () => {
    const line = JSON.stringify({ type: "text", sessionID: "sess-1", stepNumber: 1, text: "hello", timestamp: 150 });
    const parsed = parseLine(line);
    expect(parsed).toEqual({ type: "text", sessionID: "sess-1", stepNumber: 1, text: "hello", timestamp: 150 });
  });

  it("parses a tool_use event", () => {
    const line = JSON.stringify({
      type: "tool_use",
      sessionID: "sess-1",
      stepNumber: 1,
      timestamp: 130,
      toolCall: { id: "tc-1", type: "function", function: { name: "bash", arguments: "{}" } },
      toolResult: { success: true, output: "ok" },
      timing: { startedAt: 110, finishedAt: 130, durationMs: 20 },
    });
    const parsed = parseLine(line);
    expect(parsed?.type).toBe("tool_use");
    expect((parsed as { toolCall: { function: { name: string } } }).toolCall.function.name).toBe("bash");
  });

  it("parses a terminal step_finish event", () => {
    const line = JSON.stringify({
      type: "step_finish",
      sessionID: "sess-1",
      stepNumber: 1,
      timestamp: 200,
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    });
    const parsed = parseLine(line);
    expect(parsed).toMatchObject({ type: "step_finish", finishReason: "stop" });
  });

  it("parses an error event", () => {
    const line = JSON.stringify({ type: "error", sessionID: "err-session", message: "boom", timestamp: 1 });
    expect(parseLine(line)).toEqual({ type: "error", sessionID: "err-session", message: "boom", timestamp: 1 });
  });

  it("skips an empty line", () => {
    expect(parseLine("")).toBeNull();
    expect(parseLine("   ")).toBeNull();
  });

  it("skips non-JSON debug output", () => {
    expect(parseLine("[SandboxDebug] booting shuru vm")).toBeNull();
  });

  it("skips malformed JSON without throwing", () => {
    expect(() => parseLine("{not valid json")).not.toThrow();
    expect(parseLine("{not valid json")).toBeNull();
  });

  it("skips a JSON object with an unrecognized/missing type", () => {
    expect(parseLine(JSON.stringify({ foo: "bar" }))).toBeNull();
    expect(parseLine(JSON.stringify({ type: "some_future_event", data: 1 }))).toBeNull();
  });

  it("skips a JSON array (not an object)", () => {
    expect(parseLine(JSON.stringify([{ type: "text" }]))).toBeNull();
  });
});
