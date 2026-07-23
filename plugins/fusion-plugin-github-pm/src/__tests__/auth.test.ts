import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fingerprintToken,
  getGitHubAuthDiagnostics,
  mapScopesToCapabilities,
  probeGitHubScopes,
  probeGitHubScopesCached,
  resetScopeProbeCache,
  resolveGitHubAuth,
  resolveGitHubToken,
  type GitHubScopeProbeResult,
} from "../auth.js";

function fakeGh(overrides: Partial<{ available: boolean; authenticated: boolean; token: string; runFails: boolean }> = {}) {
  const { available = false, authenticated = false, token = "gh-cli-token", runFails = false } = overrides;
  return {
    isGhAvailable: vi.fn(() => available),
    isGhAuthenticated: vi.fn(() => authenticated),
    runGhAsync: vi.fn(async () => {
      if (runFails) throw new Error("gh auth token failed");
      return `${token}\n`;
    }),
  };
}

function scopeHeaderResponse(status: number, header: string | null): Response {
  const headers = new Headers();
  if (header !== null) headers.set("x-oauth-scopes", header);
  return new Response("{}", { status, headers });
}

afterEach(() => {
  resetScopeProbeCache();
  vi.restoreAllMocks();
});

describe("resolveGitHubAuth — layered auth resolver", () => {
  it("resolves via gh CLI when it is available and authenticated and no other source is configured", async () => {
    const gh = fakeGh({ available: true, authenticated: true, token: "gh-token-1" });
    const result = await resolveGitHubAuth({}, { env: {}, gh });
    expect(result).toEqual({ authenticated: true, source: "gh-cli", token: "gh-token-1" });
  });

  it("resolves via the GITHUB_TOKEN env var when gh CLI is absent/unauthenticated", async () => {
    const gh = fakeGh({ available: false, authenticated: false });
    const result = await resolveGitHubAuth({}, { env: { GITHUB_TOKEN: "env-token-1" }, gh });
    expect(result).toEqual({ authenticated: true, source: "env", token: "env-token-1" });
  });

  it("the PAT plugin setting overrides BOTH gh CLI and the env var when present", async () => {
    const gh = fakeGh({ available: true, authenticated: true, token: "gh-token-should-not-win" });
    const result = await resolveGitHubAuth(
      { personalAccessToken: "pat-override-token" },
      { env: { GITHUB_TOKEN: "env-token-should-not-win" }, gh },
    );
    expect(result).toEqual({ authenticated: true, source: "pat", token: "pat-override-token" });
    expect(gh.isGhAvailable).not.toHaveBeenCalled();
  });

  it("returns authenticated:false with source 'none' when nothing is configured, and never throws", async () => {
    const gh = fakeGh({ available: false, authenticated: false });
    const result = await resolveGitHubAuth({}, { env: {}, gh });
    expect(result).toEqual({ authenticated: false, source: "none" });
  });

  it("falls through to 'none' when gh CLI is available+authenticated but the token read throws", async () => {
    const gh = fakeGh({ available: true, authenticated: true, runFails: true });
    const result = await resolveGitHubAuth({}, { env: {}, gh });
    expect(result).toEqual({ authenticated: false, source: "none" });
  });

  it("does not fall back to gh CLI when it is available but not authenticated", async () => {
    const gh = fakeGh({ available: true, authenticated: false });
    const result = await resolveGitHubAuth({}, { env: {}, gh });
    expect(result.source).toBe("none");
    expect(gh.runGhAsync).not.toHaveBeenCalled();
  });

  it("resolveGitHubToken returns only the token string", async () => {
    const gh = fakeGh({ available: false, authenticated: false });
    const token = await resolveGitHubToken({}, { env: { GITHUB_TOKEN: "just-the-token" }, gh });
    expect(token).toBe("just-the-token");
  });

  it("ignores a blank PAT setting and falls through to env", async () => {
    const gh = fakeGh({ available: false, authenticated: false });
    const result = await resolveGitHubAuth({ personalAccessToken: "   " }, { env: { GITHUB_TOKEN: "env-fallback" }, gh });
    expect(result).toEqual({ authenticated: true, source: "env", token: "env-fallback" });
  });
});

describe("probeGitHubScopes — token-shape / scope data states", () => {
  it("parses the x-oauth-scopes header for a classic token", async () => {
    const fetchImpl = vi.fn(async () => scopeHeaderResponse(200, "repo, read:project, project"));
    const result = await probeGitHubScopes("classic-token", { fetchImpl });
    expect(result).toEqual({ status: "ok", scopes: ["repo", "read:project", "project"] });
  });

  it("reports an empty scope set when the header is present but blank", async () => {
    const fetchImpl = vi.fn(async () => scopeHeaderResponse(200, ""));
    const result = await probeGitHubScopes("classic-token", { fetchImpl });
    expect(result).toEqual({ status: "ok", scopes: [] });
  });

  it("reports non-introspectable when the header is entirely absent (fine-grained PAT / GitHub App token)", async () => {
    const fetchImpl = vi.fn(async () => scopeHeaderResponse(200, null));
    const result = await probeGitHubScopes("fine-grained-token", { fetchImpl });
    expect(result).toEqual({ status: "non-introspectable" });
  });

  it("reports auth-error for a 401 response, never confusing it with a missing scope", async () => {
    const fetchImpl = vi.fn(async () => scopeHeaderResponse(401, null));
    const result = await probeGitHubScopes("invalid-token", { fetchImpl });
    expect(result).toEqual({ status: "auth-error" });
  });

  it("reports network-error when the fetch throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const result = await probeGitHubScopes("token", { fetchImpl });
    expect(result).toEqual({ status: "network-error" });
  });

  it("issues exactly one request", async () => {
    const fetchImpl = vi.fn(async () => scopeHeaderResponse(200, "repo"));
    await probeGitHubScopes("token", { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("mapScopesToCapabilities", () => {
  it("reports project supported when the project scope is present", () => {
    const probe: GitHubScopeProbeResult = { status: "ok", scopes: ["repo", "project"] };
    expect(mapScopesToCapabilities(probe)).toEqual({ issues: "supported", discussions: "supported", projects: "supported" });
  });

  it("reports project missing when the project scope is absent from an otherwise scoped token", () => {
    const probe: GitHubScopeProbeResult = { status: "ok", scopes: ["repo"] };
    expect(mapScopesToCapabilities(probe)).toEqual({ issues: "supported", discussions: "supported", projects: "missing" });
  });

  it("accepts read:project as sufficient for the projects capability", () => {
    const probe: GitHubScopeProbeResult = { status: "ok", scopes: ["public_repo", "read:project"] };
    expect(mapScopesToCapabilities(probe).projects).toBe("supported");
  });

  it("reports every capability as unknown (never falsely missing) for a non-introspectable token", () => {
    const probe: GitHubScopeProbeResult = { status: "non-introspectable" };
    expect(mapScopesToCapabilities(probe)).toEqual({ issues: "unknown", discussions: "unknown", projects: "unknown" });
  });

  it("reports every capability as unknown for an auth-error probe", () => {
    const probe: GitHubScopeProbeResult = { status: "auth-error" };
    expect(mapScopesToCapabilities(probe)).toEqual({ issues: "unknown", discussions: "unknown", projects: "unknown" });
  });
});

describe("probeGitHubScopesCached — TTL cache keyed by token fingerprint", () => {
  it("reuses a cached result within the TTL instead of re-probing", async () => {
    const fetchImpl = vi.fn(async () => scopeHeaderResponse(200, "repo, project"));
    const first = await probeGitHubScopesCached("cached-token", { fetchImpl });
    const second = await probeGitHubScopesCached("cached-token", { fetchImpl });
    expect(first).toEqual(second);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keys the cache by a token fingerprint, never the raw token", () => {
    const fp = fingerprintToken("some-raw-token-value");
    expect(fp).not.toContain("some-raw-token-value");
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it("resetScopeProbeCache forces a fresh probe", async () => {
    const fetchImpl = vi.fn(async () => scopeHeaderResponse(200, "repo"));
    await probeGitHubScopesCached("reset-token", { fetchImpl });
    resetScopeProbeCache();
    await probeGitHubScopesCached("reset-token", { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("getGitHubAuthDiagnostics — combined UI-ready payload", () => {
  it("returns a not-authenticated diagnostics payload with remediation instructions when nothing is configured", async () => {
    const gh = fakeGh({ available: false, authenticated: false });
    const diagnostics = await getGitHubAuthDiagnostics({}, { env: {}, gh });
    expect(diagnostics.authenticated).toBe(false);
    expect(diagnostics.source).toBe("none");
    expect(diagnostics.warning?.instructions.length).toBeGreaterThan(0);
  });

  it("surfaces an actionable warning with instructions when the project scope is missing", async () => {
    const gh = fakeGh({ available: false, authenticated: false });
    const fetchImpl = vi.fn(async () => scopeHeaderResponse(200, "repo, read:org"));
    const diagnostics = await getGitHubAuthDiagnostics(
      { personalAccessToken: "classic-pat-no-project" },
      { env: {}, gh, fetchImpl },
    );
    expect(diagnostics.authenticated).toBe(true);
    expect(diagnostics.missingProjectScope).toBe(true);
    expect(diagnostics.capabilities.projects).toBe("missing");
    expect(diagnostics.warning?.message).toMatch(/project/i);
    expect(diagnostics.warning?.instructions.length).toBeGreaterThan(0);
  });

  it("does not flag missingProjectScope for a non-introspectable fine-grained token", async () => {
    const gh = fakeGh({ available: false, authenticated: false });
    const fetchImpl = vi.fn(async () => scopeHeaderResponse(200, null));
    const diagnostics = await getGitHubAuthDiagnostics(
      { personalAccessToken: "fine-grained-pat" },
      { env: {}, gh, fetchImpl },
    );
    expect(diagnostics.authenticated).toBe(true);
    expect(diagnostics.introspectable).toBe(false);
    expect(diagnostics.missingProjectScope).toBe(false);
    expect(diagnostics.capabilities).toEqual({ issues: "unknown", discussions: "unknown", projects: "unknown" });
  });

  it("reports all capabilities supported with no warning when every scope is present", async () => {
    const gh = fakeGh({ available: false, authenticated: false });
    const fetchImpl = vi.fn(async () => scopeHeaderResponse(200, "repo, project"));
    const diagnostics = await getGitHubAuthDiagnostics(
      { personalAccessToken: "fully-scoped-pat" },
      { env: {}, gh, fetchImpl },
    );
    expect(diagnostics.capabilities).toEqual({ issues: "supported", discussions: "supported", projects: "supported" });
    expect(diagnostics.missingProjectScope).toBe(false);
    expect(diagnostics.warning).toBeUndefined();
  });

  it("reports an auth-error diagnostics state (not a missing-scope state) for an invalid token", async () => {
    const gh = fakeGh({ available: false, authenticated: false });
    const fetchImpl = vi.fn(async () => scopeHeaderResponse(401, null));
    const diagnostics = await getGitHubAuthDiagnostics(
      { personalAccessToken: "revoked-pat" },
      { env: {}, gh, fetchImpl },
    );
    expect(diagnostics.authenticated).toBe(false);
    expect(diagnostics.probeStatus).toBe("auth-error");
    expect(diagnostics.warning?.message).toMatch(/rejected|expired|revoked/i);
  });

  it("degrades gracefully (does not throw) on a network error during the probe", async () => {
    const gh = fakeGh({ available: false, authenticated: false });
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const diagnostics = await getGitHubAuthDiagnostics(
      { personalAccessToken: "some-pat" },
      { env: {}, gh, fetchImpl },
    );
    expect(diagnostics.authenticated).toBe(true);
    expect(diagnostics.probeStatus).toBe("network-error");
    expect(diagnostics.capabilities).toEqual({ issues: "unknown", discussions: "unknown", projects: "unknown" });
  });
});
