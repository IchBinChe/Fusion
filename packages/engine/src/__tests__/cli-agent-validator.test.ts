import { describe, it, expect } from "vitest";
import {
  mapParsedToVerdict,
  oneShotResultToVerdict,
  normalizeVerdictToken,
  inferVerdictFromProse,
  runCliAgentValidation,
} from "../cli-agent-validator.js";
import type {
  OneShotResult,
  RunOneShotOptions,
} from "../cli-agent/one-shot-session.js";

function success(parsed: Record<string, unknown>, text = ""): OneShotResult {
  return { ok: true, sessionId: "s1", parsed, text, rawOutput: JSON.stringify(parsed) };
}

describe("verdict token normalization", () => {
  it("maps synonyms to the contract set", () => {
    expect(normalizeVerdictToken("APPROVE")).toBe("pass");
    expect(normalizeVerdictToken("passed")).toBe("pass");
    expect(normalizeVerdictToken("REVISE")).toBe("fail");
    expect(normalizeVerdictToken("blocked")).toBe("blocked");
    expect(normalizeVerdictToken("nonsense")).toBeNull();
  });
});

describe("mapParsedToVerdict — per-adapter shapes → verdicts", () => {
  it("claude-shaped pass (is_error:false + verdict)", () => {
    const v = mapParsedToVerdict({ type: "result", verdict: "pass", is_error: false }, "");
    expect(v.status).toBe("pass");
  });

  it("claude-shaped error flag is authoritative", () => {
    const v = mapParsedToVerdict({ is_error: true, result: "crashed" }, "");
    expect(v.status).toBe("error");
  });

  it("boolean passed:false → fail", () => {
    const v = mapParsedToVerdict({ passed: false, summary: "missing X" }, "");
    expect(v.status).toBe("fail");
    expect(v.summary).toBe("missing X");
  });

  it("explicit blocked flag → blocked with reason", () => {
    const v = mapParsedToVerdict({ blocked: true, reason: "needs creds" }, "");
    expect(v.status).toBe("blocked");
    expect(v.blockedReason).toBe("needs creds");
  });

  it("status token + assertions array", () => {
    const v = mapParsedToVerdict(
      {
        status: "fail",
        assertions: [
          { assertionId: "a1", passed: true },
          { id: "a2", passed: false, message: "nope" },
        ],
      },
      "",
    );
    expect(v.status).toBe("fail");
    expect(v.assertions).toHaveLength(2);
    expect(v.assertions[1]).toEqual({ assertionId: "a2", passed: false, message: "nope" });
  });

  it("prose-only pass inference", () => {
    expect(inferVerdictFromProse("All assertions pass.")).toBe("pass");
    const v = mapParsedToVerdict({}, "All assertions pass.");
    expect(v.status).toBe("pass");
  });

  it("MALFORMED / undecidable → error, NEVER pass", () => {
    const v = mapParsedToVerdict({ irrelevant: 1 }, "the agent rambled without a verdict");
    expect(v.status).toBe("error");
  });
});

describe("oneShotResultToVerdict — failures map to error", () => {
  it("nonzero exit → error with stderr in summary", () => {
    const v = oneShotResultToVerdict({
      ok: false,
      reason: "nonzero-exit",
      sessionId: "s1",
      exitCode: 1,
      stderr: "segfault",
      message: "exited with code 1",
    });
    expect(v.status).toBe("error");
    expect(v.summary).toContain("segfault");
  });

  it("unparseable → error (never silent pass)", () => {
    const v = oneShotResultToVerdict({
      ok: false,
      reason: "unparseable",
      sessionId: "s1",
      exitCode: 0,
      stderr: "garbage",
      message: "no decodable result",
    });
    expect(v.status).toBe("error");
  });

  it("success with pass verdict → pass", () => {
    expect(oneShotResultToVerdict(success({ verdict: "pass" })).status).toBe("pass");
  });
});

describe("runCliAgentValidation — seam threads purpose:validator and maps verdict", () => {
  it("invokes runner with validator purpose and returns the verdict", async () => {
    let seenPurpose: string | undefined;
    const fakeRun = async (opts: RunOneShotOptions): Promise<OneShotResult> => {
      seenPurpose = opts.purpose;
      return success({ verdict: "pass", summary: "looks good" }, "looks good");
    };
    const verdict = await runCliAgentValidation(
      {
        manager: {} as RunOneShotOptions["manager"],
        adapterId: "claude-code",
        projectId: "p",
        prompt: "validate",
        cwd: "/tmp",
      },
      fakeRun as never,
    );
    expect(seenPurpose).toBe("validator");
    expect(verdict.status).toBe("pass");
    expect(verdict.summary).toBe("looks good");
  });

  it("runner failure surfaces as error verdict", async () => {
    const fakeRun = async (): Promise<OneShotResult> => ({
      ok: false,
      reason: "spawn-failed",
      sessionId: null,
      exitCode: null,
      stderr: "",
      message: "ENOENT claude",
    });
    const verdict = await runCliAgentValidation(
      {
        manager: {} as RunOneShotOptions["manager"],
        adapterId: "claude-code",
        projectId: "p",
        prompt: "validate",
        cwd: "/tmp",
      },
      fakeRun as never,
    );
    expect(verdict.status).toBe("error");
  });
});
