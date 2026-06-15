import { describe, it, expect } from "vitest";
import { claudeAcpExperimentalEnabled, applyClaudeAcpEnable } from "../claude-acp-enable.js";

describe("claudeAcpExperimentalEnabled — default ON", () => {
  it("is ON when no settings / no experimentalFeatures", () => {
    expect(claudeAcpExperimentalEnabled(undefined)).toBe(true);
    expect(claudeAcpExperimentalEnabled({})).toBe(true);
    expect(claudeAcpExperimentalEnabled({ experimentalFeatures: {} })).toBe(true);
  });
  it("is ON when explicitly true", () => {
    expect(claudeAcpExperimentalEnabled({ experimentalFeatures: { claudeCliAcp: true } })).toBe(true);
  });
  it("is OFF only when explicitly false", () => {
    expect(claudeAcpExperimentalEnabled({ experimentalFeatures: { claudeCliAcp: false } })).toBe(false);
  });
});

describe("applyClaudeAcpEnable — translates the flag to FUSION_CLAUDE_ACP", () => {
  it("sets FUSION_CLAUDE_ACP=1 when enabled (default ON) and env unset", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyClaudeAcpEnable({}, env)).toBe(true);
    expect(env.FUSION_CLAUDE_ACP).toBe("1");
  });
  it("does NOT set the env when the flag is explicitly false", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyClaudeAcpEnable({ experimentalFeatures: { claudeCliAcp: false } }, env)).toBe(false);
    expect(env.FUSION_CLAUDE_ACP).toBeUndefined();
  });
  it("honors an explicit env override (operator/test wins over the flag)", () => {
    const off: NodeJS.ProcessEnv = { FUSION_CLAUDE_ACP: "0" };
    expect(applyClaudeAcpEnable({}, off)).toBe(false); // flag default-on, but env says off
    expect(off.FUSION_CLAUDE_ACP).toBe("0");

    const on: NodeJS.ProcessEnv = { FUSION_CLAUDE_ACP: "1" };
    expect(applyClaudeAcpEnable({ experimentalFeatures: { claudeCliAcp: false } }, on)).toBe(true);
    expect(on.FUSION_CLAUDE_ACP).toBe("1");
  });
});
