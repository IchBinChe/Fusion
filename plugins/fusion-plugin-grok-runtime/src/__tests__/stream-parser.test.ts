import { describe, expect, it } from "vitest";
import { parseLine } from "../stream-parser.js";

/*
FNXC:GrokCli 2026-07-10-11:02:
FN-7790: fixtures use xAI Grok Build TUI's real `--output-format streaming-json` schema captured from the operator binary. Keep tests on `thought`/`text`/`end` so a future wrong-product `step_*`/`tool_use` assumption fails deterministically before production returns no messages again.
*/

describe("parseLine (xAI Grok CLI streaming-json)", () => {
  it("parses a thought event", () => {
    const line = JSON.stringify({ type: "thought", data: "Thinking" });
    expect(parseLine(line)).toEqual({ type: "thought", data: "Thinking" });
  });

  it("parses a text event", () => {
    const line = JSON.stringify({ type: "text", data: "Hello" });
    expect(parseLine(line)).toEqual({ type: "text", data: "Hello" });
  });

  it("parses an end event", () => {
    const line = JSON.stringify({
      type: "end",
      stopReason: "EndTurn",
      sessionId: "session-1",
      requestId: "request-1",
    });
    expect(parseLine(line)).toEqual({
      type: "end",
      stopReason: "EndTurn",
      sessionId: "session-1",
      requestId: "request-1",
    });
  });

  it("skips empty and non-JSON lines", () => {
    expect(parseLine("")).toBeNull();
    expect(parseLine("   ")).toBeNull();
    expect(parseLine("[SandboxDebug] booting")).toBeNull();
  });

  it("skips malformed JSON without throwing", () => {
    expect(() => parseLine("{not valid json")).not.toThrow();
    expect(parseLine("{not valid json")).toBeNull();
  });

  it("skips missing, unknown, and legacy wrong-product event types", () => {
    expect(parseLine(JSON.stringify({ foo: "bar" }))).toBeNull();
    expect(parseLine(JSON.stringify({ type: "some_future_event", data: 1 }))).toBeNull();
    expect(parseLine(JSON.stringify({ type: "step_start", stepNumber: 1 }))).toBeNull();
    expect(parseLine(JSON.stringify({ type: "tool_use", toolCall: {}, toolResult: {} }))).toBeNull();
  });

  it("skips a JSON array", () => {
    expect(parseLine(JSON.stringify([{ type: "text", data: "hi" }]))).toBeNull();
  });
});
