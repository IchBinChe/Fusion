import { describe, expect, it } from "vitest";
import { capabilityForTab, GITHUB_PM_CAPABILITY_TAB_ORDER, mapRepoCapabilitiesToTabs } from "../tab-capabilities.js";
import type { RepoCapabilities } from "../repo-capabilities.js";

function baseCapabilities(overrides: Partial<RepoCapabilities["tabs"]> = {}): RepoCapabilities {
  return {
    repo: "acme/widgets",
    authenticated: true,
    tabs: {
      issues: { available: true },
      labels: { available: true },
      milestones: { available: true },
      discussions: { available: true },
      projects: { available: true },
      triage: { available: true },
      ...overrides,
    },
  };
}

describe("mapRepoCapabilitiesToTabs", () => {
  it("preserves the canonical six-tab order: issues, labels, milestones, discussions, projects, triage", () => {
    const result = mapRepoCapabilitiesToTabs(baseCapabilities());
    expect(result.map((tab) => tab.id)).toEqual(["issues", "labels", "milestones", "discussions", "projects", "triage"]);
    expect(GITHUB_PM_CAPABILITY_TAB_ORDER.map((tab) => tab.id)).toEqual(["issues", "labels", "milestones", "discussions", "projects", "triage"]);
  });

  it("returns every tab as not-disabled when capabilities have not loaded yet (undefined)", () => {
    const result = mapRepoCapabilitiesToTabs(undefined);
    expect(result).toHaveLength(6);
    for (const tab of result) {
      expect(tab.disabled).toBe(false);
      expect(tab.reason).toBeUndefined();
    }
  });

  it("Discussions disabled (feature-disabled) maps to disabled:true with reason/message/fix propagated", () => {
    const capabilities = baseCapabilities({
      discussions: {
        available: false,
        reason: "feature-disabled",
        message: "Discussions are not enabled for this repository.",
        fix: ["Ask the repository owner to enable Discussions in the repository's Settings → Features."],
      },
    });
    const result = mapRepoCapabilitiesToTabs(capabilities);
    const discussions = result.find((tab) => tab.id === "discussions")!;
    expect(discussions.disabled).toBe(true);
    expect(discussions.reason).toBe("feature-disabled");
    expect(discussions.message).toMatch(/discussions/i);
    expect(discussions.fix?.length).toBeGreaterThan(0);
  });

  it("Projects missing-scope maps to disabled:true with the fix path", () => {
    const capabilities = baseCapabilities({
      projects: {
        available: false,
        reason: "missing-scope",
        message: "This token lacks the 'project' scope, so Projects v2 boards are unavailable.",
        fix: ["Open https://github.com/settings/tokens and edit or create a personal access token."],
      },
    });
    const result = mapRepoCapabilitiesToTabs(capabilities);
    const projects = result.find((tab) => tab.id === "projects")!;
    expect(projects.disabled).toBe(true);
    expect(projects.reason).toBe("missing-scope");
    expect(projects.fix?.length).toBeGreaterThan(0);
  });

  it("Projects 'unknown' (non-introspectable token) stays enabled -- never falsely blocked", () => {
    const capabilities = baseCapabilities({
      projects: {
        available: true,
        reason: "unknown",
        message: "This token's scopes can't be confirmed. Projects v2 support is unknown, not confirmed missing.",
      },
    });
    const result = mapRepoCapabilitiesToTabs(capabilities);
    const projects = result.find((tab) => tab.id === "projects")!;
    expect(projects.disabled).toBe(false);
    expect(projects.reason).toBe("unknown");
    expect(projects.message).toBeTruthy();
  });

  it("Labels/Milestones/Triage stay enabled regardless of Issues/Discussions/Projects gating", () => {
    const capabilities = baseCapabilities({
      issues: { available: false, reason: "feature-disabled", message: "Issues are not enabled for this repository.", fix: ["x"] },
      discussions: { available: false, reason: "feature-disabled", message: "Discussions are not enabled for this repository.", fix: ["x"] },
      projects: { available: false, reason: "missing-scope", message: "missing", fix: ["x"] },
    });
    const result = mapRepoCapabilitiesToTabs(capabilities);
    for (const id of ["labels", "milestones", "triage"] as const) {
      const tab = result.find((t) => t.id === id)!;
      expect(tab.disabled).toBe(false);
    }
  });

  it("not-authenticated disables every tab with a fix path", () => {
    const capabilities = baseCapabilities({
      issues: { available: false, reason: "not-authenticated", message: "GitHub PM is not authenticated.", fix: ["Run 'gh auth login'."] },
      labels: { available: false, reason: "not-authenticated", message: "GitHub PM is not authenticated.", fix: ["Run 'gh auth login'."] },
      milestones: { available: false, reason: "not-authenticated", message: "GitHub PM is not authenticated.", fix: ["Run 'gh auth login'."] },
      discussions: { available: false, reason: "not-authenticated", message: "GitHub PM is not authenticated.", fix: ["Run 'gh auth login'."] },
      projects: { available: false, reason: "not-authenticated", message: "GitHub PM is not authenticated.", fix: ["Run 'gh auth login'."] },
      triage: { available: false, reason: "not-authenticated", message: "GitHub PM is not authenticated.", fix: ["Run 'gh auth login'."] },
    });
    const result = mapRepoCapabilitiesToTabs(capabilities);
    expect(result.every((tab) => tab.disabled)).toBe(true);
    expect(result.every((tab) => tab.reason === "not-authenticated")).toBe(true);
    expect(result.every((tab) => (tab.fix?.length ?? 0) > 0)).toBe(true);
  });
});

describe("capabilityForTab", () => {
  it("returns undefined when capabilities haven't loaded", () => {
    expect(capabilityForTab(undefined, "issues")).toBeUndefined();
  });

  it("returns the raw capability entry for a loaded payload", () => {
    const capabilities = baseCapabilities();
    expect(capabilityForTab(capabilities, "triage")).toEqual({ available: true });
  });
});
