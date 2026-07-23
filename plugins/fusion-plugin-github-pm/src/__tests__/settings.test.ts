import { describe, expect, it } from "vitest";
import { GITHUB_PM_PLUGIN_ID, githubPmSettingsSchema, hasPersonalAccessToken, resolveGitHubPmSettings } from "../settings.js";

describe("github-pm settings", () => {
  it("exposes the stable plugin id", () => {
    expect(GITHUB_PM_PLUGIN_ID).toBe("fusion-plugin-github-pm");
  });

  it("trims whitespace and applies the default autonomy", () => {
    const resolved = resolveGitHubPmSettings({ personalAccessToken: "  ghp_abc  ", defaultRepo: " owner/repo " });
    expect(resolved).toEqual({
      personalAccessToken: "ghp_abc",
      defaultRepo: "owner/repo",
      defaultAutonomy: "approve-all",
      selectedRepo: null,
      repoConfigs: {},
      taxonomyProposals: {},
      recentRepos: [],
      confirmWrites: true,
    });
  });

  it("FUSI-017: confirmWrites defaults ON when unset", () => {
    expect(resolveGitHubPmSettings({}).confirmWrites).toBe(true);
  });

  it("FUSI-017: confirmWrites stays ON for an explicit true", () => {
    expect(resolveGitHubPmSettings({ confirmWrites: true }).confirmWrites).toBe(true);
  });

  it("FUSI-017: confirmWrites turns OFF only for an explicit false", () => {
    expect(resolveGitHubPmSettings({ confirmWrites: false }).confirmWrites).toBe(false);
  });

  it("FUSI-017: confirmWrites resolves ON for any non-false value (string/number junk)", () => {
    expect(resolveGitHubPmSettings({ confirmWrites: "false" as unknown as boolean }).confirmWrites).toBe(true);
    expect(resolveGitHubPmSettings({ confirmWrites: 0 as unknown as boolean }).confirmWrites).toBe(true);
  });

  it("surfaces the FUSI-005 taxonomy proposal state map from the settings blob", () => {
    const resolved = resolveGitHubPmSettings({
      taxonomyProposalState: JSON.stringify({ "owner/repo": { proposals: [{ version: 1, generatedAt: "2026-07-24T00:00:00.000Z", status: "draft", sourceStats: { issueCount: 1, discussionCount: 0, existingLabelCount: 1 }, labels: [], fields: [], categories: [] }] } }),
    });
    expect(resolved.taxonomyProposals["owner/repo"].proposals).toHaveLength(1);
  });

  it("surfaces the selected repo and per-repo config map from the settings blob (FUSI-004)", () => {
    const resolved = resolveGitHubPmSettings({
      selectedRepo: "Owner/Repo",
      repoConfigState: JSON.stringify({ "owner/repo": { autonomyMode: "auto", approvedTaxonomyVersion: 1, viewPreferences: {}, updatedAt: "2026-07-24T00:00:00.000Z" } }),
    });
    expect(resolved.selectedRepo).toBe("owner/repo");
    expect(resolved.repoConfigs["owner/repo"]?.autonomyMode).toBe("auto");
  });

  it("falls back to approve-all for an unknown autonomy value", () => {
    const resolved = resolveGitHubPmSettings({ defaultAutonomy: "not-a-real-value" });
    expect(resolved.defaultAutonomy).toBe("approve-all");
  });

  it("accepts a valid non-default autonomy value", () => {
    const resolved = resolveGitHubPmSettings({ defaultAutonomy: "auto" });
    expect(resolved.defaultAutonomy).toBe("auto");
  });

  it("returns undefined for empty/whitespace-only optional settings", () => {
    const resolved = resolveGitHubPmSettings({ personalAccessToken: "   ", defaultRepo: "" });
    expect(resolved.personalAccessToken).toBeUndefined();
    expect(resolved.defaultRepo).toBeUndefined();
  });

  it("reports whether a personal access token is configured without exposing it", () => {
    expect(hasPersonalAccessToken({})).toBe(false);
    expect(hasPersonalAccessToken({ personalAccessToken: "ghp_secret" })).toBe(true);
  });

  it("matches the manifest settingsSchema shape", () => {
    expect(githubPmSettingsSchema.personalAccessToken.type).toBe("password");
    expect(githubPmSettingsSchema.defaultRepo.type).toBe("string");
    expect(githubPmSettingsSchema.defaultAutonomy.type).toBe("enum");
  });

  it("FUSI-017: declares confirmWrites as a boolean setting defaulting ON", () => {
    expect(githubPmSettingsSchema.confirmWrites.type).toBe("boolean");
    expect(githubPmSettingsSchema.confirmWrites.defaultValue).toBe(true);
  });
});
