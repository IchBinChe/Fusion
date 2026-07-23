import { afterEach, describe, expect, it } from "vitest";
import { resolveRepoCapabilities, type ResolveRepoCapabilitiesOptions } from "../repo-capabilities.js";
import { resetScopeProbeCache } from "../auth.js";
import { GitHubApiError, type GitHubRepositoryFeatures } from "../github-client.js";

const TOKEN = "secret-repo-caps-token-xyz";

// The scope probe is cached by token fingerprint (auth.ts); reset between tests so every
// test's own fetchImpl-scripted response is the one actually observed.
afterEach(() => {
  resetScopeProbeCache();
});

function scopeHeaderResponse(status: number, header: string | null): Response {
  const headers = new Headers();
  if (header !== null) headers.set("x-oauth-scopes", header);
  return new Response("{}", { status, headers });
}

function fetchImplForScopes(header: string | null, status = 200): typeof fetch {
  return (async () => scopeHeaderResponse(status, header)) as unknown as typeof fetch;
}

function authenticatedOptions(header: string | null): ResolveRepoCapabilitiesOptions {
  return {
    env: { GITHUB_TOKEN: TOKEN },
    gh: { isGhAvailable: () => false, isGhAuthenticated: () => false, runGhAsync: async () => "" },
    fetchImpl: fetchImplForScopes(header),
  };
}

function withRepoFeatures(base: ResolveRepoCapabilitiesOptions, features: GitHubRepositoryFeatures): ResolveRepoCapabilitiesOptions {
  return { ...base, createClient: () => ({ getRepositoryFeatures: async () => features }) };
}

function withRepoFeaturesError(base: ResolveRepoCapabilitiesOptions, error: unknown): ResolveRepoCapabilitiesOptions {
  return {
    ...base,
    createClient: () => ({
      getRepositoryFeatures: async () => {
        throw error;
      },
    }),
  };
}

const FULL_FEATURES: GitHubRepositoryFeatures = {
  hasIssuesEnabled: true,
  hasDiscussionsEnabled: true,
  hasProjectsEnabled: true,
  viewerPermission: "WRITE",
};

describe("resolveRepoCapabilities", () => {
  it("authenticated + discussions disabled on the repo -> Discussions tab disabled with feature-disabled reason, message, and fix", async () => {
    const options = withRepoFeatures(authenticatedOptions("repo"), { ...FULL_FEATURES, hasDiscussionsEnabled: false });
    const result = await resolveRepoCapabilities({}, "acme/widgets", options);

    expect(result.authenticated).toBe(true);
    expect(result.tabs.discussions.available).toBe(false);
    expect(result.tabs.discussions.reason).toBe("feature-disabled");
    expect(result.tabs.discussions.message).toMatch(/discussions/i);
    expect(result.tabs.discussions.fix?.length).toBeGreaterThan(0);
    // Issues stays available -- only the disabled feature is gated.
    expect(result.tabs.issues.available).toBe(true);
  });

  it("authenticated + projects scope missing -> Projects tab disabled with missing-scope reason and a fix path", async () => {
    // Scope header without 'project'/'read:project' -> projects capability = missing.
    const options = withRepoFeatures(authenticatedOptions("repo"), FULL_FEATURES);
    const result = await resolveRepoCapabilities({}, "acme/widgets", options);

    expect(result.tabs.projects.available).toBe(false);
    expect(result.tabs.projects.reason).toBe("missing-scope");
    expect(result.tabs.projects.fix?.length).toBeGreaterThan(0);
  });

  it("projects scope unknown (fine-grained/App token, non-introspectable) -> Projects stays available, never falsely blocked", async () => {
    // null scope header -> non-introspectable -> every capability 'unknown'.
    const options = withRepoFeatures(authenticatedOptions(null), FULL_FEATURES);
    const result = await resolveRepoCapabilities({}, "acme/widgets", options);

    expect(result.tabs.projects.available).toBe(true);
    expect(result.tabs.projects.reason).toBe("unknown");
    // Issues capability is also 'unknown' in this state -- it must not be falsely blocked either.
    expect(result.tabs.issues.available).toBe(true);
  });

  it("not authenticated -> every tab is disabled with not-authenticated reason and a fix path", async () => {
    const options: ResolveRepoCapabilitiesOptions = { env: {}, gh: { isGhAvailable: () => false, isGhAuthenticated: () => false, runGhAsync: async () => "" } };
    const result = await resolveRepoCapabilities({}, "acme/widgets", options);

    expect(result.authenticated).toBe(false);
    for (const tabId of ["issues", "labels", "milestones", "discussions", "projects", "triage"] as const) {
      expect(result.tabs[tabId].available).toBe(false);
      expect(result.tabs[tabId].reason).toBe("not-authenticated");
      expect(result.tabs[tabId].fix?.length).toBeGreaterThan(0);
    }
  });

  it("repo fetch 404 (not found) -> issues/discussions get repo-access-error with a fix path and NO raw error string", async () => {
    const rawError = new GitHubApiError(404, "Repository acme/ghost was not found or is not accessible with the current token.", "not_found");
    const options = withRepoFeaturesError(authenticatedOptions("repo"), rawError);
    const result = await resolveRepoCapabilities({}, "acme/ghost", options);

    expect(result.tabs.issues.available).toBe(false);
    expect(result.tabs.issues.reason).toBe("repo-access-error");
    expect(result.tabs.discussions.available).toBe(false);
    expect(result.tabs.discussions.reason).toBe("repo-access-error");
    expect(result.tabs.issues.message).not.toContain(rawError.message);
    expect(result.tabs.discussions.message).not.toContain(rawError.message);
    expect(result.tabs.issues.fix?.length).toBeGreaterThan(0);
  });

  it("repo fetch 403 (no access) -> issues/discussions get repo-access-error, not a raw error", async () => {
    const rawError = new GitHubApiError(403, "Resource not accessible by integration", "auth_error");
    const options = withRepoFeaturesError(authenticatedOptions("repo"), rawError);
    const result = await resolveRepoCapabilities({}, "acme/private-repo", options);

    expect(result.tabs.issues.reason).toBe("repo-access-error");
    expect(result.tabs.discussions.reason).toBe("repo-access-error");
    expect(JSON.stringify(result)).not.toContain(rawError.message);
  });

  it("network error while probing repo features -> degrades (tabs stay available with a soft note), never throws", async () => {
    const options = withRepoFeaturesError(authenticatedOptions("repo"), new TypeError("fetch failed"));
    const result = await resolveRepoCapabilities({}, "acme/widgets", options);

    expect(result.tabs.issues.available).toBe(true);
    expect(result.tabs.discussions.available).toBe(true);
    expect(result.tabs.issues.message).toBeTruthy();
  });

  it("Labels/Milestones/Triage stay available whenever authenticated, independent of repo-feature/scope gating", async () => {
    const options = withRepoFeatures(authenticatedOptions("repo"), { ...FULL_FEATURES, hasIssuesEnabled: false, hasDiscussionsEnabled: false });
    const result = await resolveRepoCapabilities({}, "acme/widgets", options);

    expect(result.tabs.labels).toEqual({ available: true });
    expect(result.tabs.milestones).toEqual({ available: true });
    expect(result.tabs.triage).toEqual({ available: true });
  });

  it("never includes the resolved token anywhere in the output", async () => {
    const options = withRepoFeatures(authenticatedOptions("repo"), FULL_FEATURES);
    const result = await resolveRepoCapabilities({}, "acme/widgets", options);

    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("never throws, even for an unexpected non-GitHubApiError failure", async () => {
    const options = withRepoFeaturesError(authenticatedOptions("repo"), new Error("boom"));
    await expect(resolveRepoCapabilities({}, "acme/widgets", options)).resolves.toBeDefined();
  });
});
