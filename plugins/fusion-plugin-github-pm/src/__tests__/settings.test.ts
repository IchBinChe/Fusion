import { describe, expect, it } from "vitest";
import { GITHUB_PM_PLUGIN_ID, githubPmSettingsSchema, hasPersonalAccessToken, resolveGitHubPmSettings } from "../settings.js";

describe("github-pm settings", () => {
  it("exposes the stable plugin id", () => {
    expect(GITHUB_PM_PLUGIN_ID).toBe("fusion-plugin-github-pm");
  });

  it("trims whitespace and applies the default autonomy", () => {
    const resolved = resolveGitHubPmSettings({ personalAccessToken: "  ghp_abc  ", defaultRepo: " owner/repo " });
    expect(resolved).toEqual({ personalAccessToken: "ghp_abc", defaultRepo: "owner/repo", defaultAutonomy: "approve-all" });
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
});
