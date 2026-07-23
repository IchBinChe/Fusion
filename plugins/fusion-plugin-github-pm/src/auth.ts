import { createHash } from "node:crypto";
import { isGhAuthenticated, isGhAvailable, runGhAsync } from "@fusion/core";
import { hasPersonalAccessToken, resolveGitHubPmSettings } from "./settings.js";

/*
FNXC:GithubPmAuth 2026-07-24-00:00:
FUSI-002 mission: "Auth chain: detect gh CLI login -> fall back to GITHUB_TOKEN env
-> allow PAT override from plugin settings." Taken literally that reads gh-CLI-first,
but the same mission paragraph explains the PAT exists precisely so a user can grant
EXTRA scopes (e.g. `project` for Projects v2) beyond whatever an ambient gh CLI/env
token has. An override that is silently outranked by auto-detected sources cannot do
that job. Per the task's explicit "Mission" and "Step 1" clarification, the actually
implemented precedence is:
  1. PAT plugin setting (when non-empty) -- explicit user override, highest precedence
  2. GITHUB_TOKEN environment variable
  3. gh CLI (available AND authenticated) -- read via `gh auth token`
  4. none configured -- return `authenticated: false`, never throw
This plugin must never grow a separate GitHub OAuth/login flow: these three sources
(plus their absence) are the only ways a token is ever obtained. The resolver below
is the SINGLE token-read entry point for the whole plugin -- routes, tools, and the
FUSI-003 GitHub client all import `resolveGitHubAuth`/`resolveGitHubToken` from here
rather than reading `process.env.GITHUB_TOKEN` or shelling out to `gh` a second time.
*/

export type GitHubAuthSource = "pat" | "env" | "gh-cli" | "none";

export interface GitHubAuthResult {
  authenticated: boolean;
  source: GitHubAuthSource;
  /** The resolved token value. Never log, echo, or persist this field. */
  token?: string;
}

export interface ResolveGitHubAuthOptions {
  /** Override for tests: defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Override for tests: defaults to the real `@fusion/core` gh-cli helpers. */
  gh?: {
    isGhAvailable: () => boolean;
    isGhAuthenticated: () => boolean;
    runGhAsync: (args: string[], opts?: { timeoutMs?: number }) => Promise<string>;
  };
}

const defaultGh = { isGhAvailable, isGhAuthenticated, runGhAsync };

/**
 * Resolve a usable GitHub token following the plugin's layered auth chain.
 * Never throws for the "nothing configured" case -- callers get a structured
 * `{ authenticated: false, source: "none" }` result instead of an exception.
 */
export async function resolveGitHubAuth(
  settings: Record<string, unknown>,
  options: ResolveGitHubAuthOptions = {},
): Promise<GitHubAuthResult> {
  const env = options.env ?? process.env;
  const gh = options.gh ?? defaultGh;

  // 1. PAT plugin setting -- explicit override, highest precedence.
  if (hasPersonalAccessToken(settings)) {
    const { personalAccessToken } = resolveGitHubPmSettings(settings);
    if (personalAccessToken) {
      return { authenticated: true, source: "pat", token: personalAccessToken };
    }
  }

  // 2. GITHUB_TOKEN environment variable.
  const envToken = env.GITHUB_TOKEN?.trim();
  if (envToken) {
    return { authenticated: true, source: "env", token: envToken };
  }

  // 3. gh CLI -- must be both installed and authenticated before reading a token.
  try {
    if (gh.isGhAvailable() && gh.isGhAuthenticated()) {
      const rawToken = await gh.runGhAsync(["auth", "token"], { timeoutMs: 10_000 });
      const ghToken = rawToken.trim();
      if (ghToken) {
        return { authenticated: true, source: "gh-cli", token: ghToken };
      }
    }
  } catch {
    // gh CLI probing is best-effort; any failure here just falls through to "none".
  }

  // 4. Nothing configured -- never throw to the caller.
  return { authenticated: false, source: "none" };
}

/** Convenience helper for callers (e.g. the FUSI-003 GitHub client) that only need the token string. */
export async function resolveGitHubToken(
  settings: Record<string, unknown>,
  options?: ResolveGitHubAuthOptions,
): Promise<string | undefined> {
  const result = await resolveGitHubAuth(settings, options);
  return result.token;
}

/*
FNXC:GithubPmAuth 2026-07-24-00:10:
Scope introspection needs exactly ONE authenticated request (mission constraint: FUSI-002
must not require FUSI-003's full GitHub client). GET /user is cheap, works for both classic
and fine-grained/App tokens, and returns the `x-oauth-scopes` response header ONLY for
classic OAuth/PAT tokens. Fine-grained PATs and GitHub App installation tokens omit that
header entirely -- that omission is not "zero scopes", it means classic scopes cannot be
read at all, so those tokens must report capabilities as "unknown", never a false "missing"
for `project`. A 401 is a distinct auth-error state (bad/expired token), not a scope gap.
*/

export type GitHubScopeProbeStatus = "ok" | "non-introspectable" | "auth-error" | "network-error";

export interface GitHubScopeProbeResult {
  status: GitHubScopeProbeStatus;
  /** Present only when status === "ok": the parsed x-oauth-scopes scope set. */
  scopes?: string[];
}

export type CapabilityState = "supported" | "missing" | "unknown";

export interface GitHubCapabilities {
  issues: CapabilityState;
  discussions: CapabilityState;
  projects: CapabilityState;
}

export interface ScopeProbeOptions {
  /** Override for tests: defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Probe endpoint override for tests. Defaults to https://api.github.com/user. */
  probeUrl?: string;
}

function parseScopeHeader(header: string | null): string[] | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (!trimmed) return [];
  return trimmed.split(",").map((scope) => scope.trim()).filter(Boolean);
}

/**
 * Issue ONE authenticated GET against the GitHub API and read the
 * `x-oauth-scopes` response header. Never throws -- network/auth failures
 * are reported as typed result states so callers can render a degraded
 * diagnostics panel instead of crashing.
 */
export async function probeGitHubScopes(token: string, options: ScopeProbeOptions = {}): Promise<GitHubScopeProbeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const probeUrl = options.probeUrl ?? "https://api.github.com/user";
  try {
    const res = await fetchImpl(probeUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (res.status === 401) {
      return { status: "auth-error" };
    }
    const scopes = parseScopeHeader(res.headers.get("x-oauth-scopes"));
    if (scopes === undefined) {
      // Fine-grained PAT or GitHub App token: classic scopes are unintrospectable.
      return { status: "non-introspectable" };
    }
    return { status: "ok", scopes };
  } catch {
    return { status: "network-error" };
  }
}

const ISSUE_SCOPES = ["repo", "public_repo"];
const DISCUSSION_SCOPES = ["repo", "public_repo"];
const PROJECT_SCOPES = ["project", "read:project"];

function hasAnyScope(scopes: string[], required: string[]): boolean {
  return required.some((scope) => scopes.includes(scope));
}

/**
 * Map a scope probe result to per-capability support. Non-introspectable
 * tokens (fine-grained PAT / GitHub App) report every capability as
 * "unknown" rather than falsely claiming `project` is missing.
 */
export function mapScopesToCapabilities(probe: GitHubScopeProbeResult): GitHubCapabilities {
  if (probe.status !== "ok" || !probe.scopes) {
    return { issues: "unknown", discussions: "unknown", projects: "unknown" };
  }
  const { scopes } = probe;
  return {
    issues: hasAnyScope(scopes, ISSUE_SCOPES) ? "supported" : "missing",
    discussions: hasAnyScope(scopes, DISCUSSION_SCOPES) ? "supported" : "missing",
    projects: hasAnyScope(scopes, PROJECT_SCOPES) ? "supported" : "missing",
  };
}

/*
FNXC:GithubPmAuth 2026-07-24-00:15:
Mirrors the gh-cli.ts 60s memo-cache rationale: diagnostics can be polled repeatedly
(dashboard panel mount, status route, tools) and each hit would otherwise re-probe
GitHub. Cache is keyed by a SHA-256 fingerprint of the token -- never the raw token --
so cache internals never leak credential material, and callers can reset it explicitly
when settings change (a new PAT should not reuse a stale cache entry keyed by coincidence).
*/
const SCOPE_PROBE_TTL_MS = 60_000;

interface CacheEntry {
  result: GitHubScopeProbeResult;
  at: number;
}

const scopeProbeCache = new Map<string, CacheEntry>();

export function fingerprintToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Clear the scope-probe cache. Call when plugin settings (e.g. the PAT) change. */
export function resetScopeProbeCache(): void {
  scopeProbeCache.clear();
}

/** Probe scopes with a short TTL cache keyed by a token fingerprint (never the raw token). */
export async function probeGitHubScopesCached(token: string, options: ScopeProbeOptions = {}): Promise<GitHubScopeProbeResult> {
  const key = fingerprintToken(token);
  const cached = scopeProbeCache.get(key);
  if (cached && Date.now() - cached.at < SCOPE_PROBE_TTL_MS) {
    return cached.result;
  }
  const result = await probeGitHubScopes(token, options);
  scopeProbeCache.set(key, { result, at: Date.now() });
  return result;
}

export interface GitHubAuthDiagnostics {
  authenticated: boolean;
  source: GitHubAuthSource;
  /** True when the token's classic scopes could be read (false for fine-grained/App tokens or when unauthenticated). */
  introspectable: boolean;
  probeStatus: GitHubScopeProbeStatus | "skipped";
  capabilities: GitHubCapabilities;
  missingProjectScope: boolean;
  warning?: { message: string; instructions: string[] };
}

function unauthenticatedDiagnostics(): GitHubAuthDiagnostics {
  return {
    authenticated: false,
    source: "none",
    introspectable: false,
    probeStatus: "skipped",
    capabilities: { issues: "unknown", discussions: "unknown", projects: "unknown" },
    missingProjectScope: false,
    warning: {
      message: "GitHub PM is not authenticated.",
      instructions: [
        "Run 'gh auth login' to authenticate the GitHub CLI, or",
        "Set the GITHUB_TOKEN environment variable, or",
        "Add a personal access token in Plugin Manager settings (Authentication group).",
      ],
    },
  };
}

/**
 * Combine the auth resolver and scope probe into a UI-ready diagnostics
 * payload. Never includes the raw token -- only `source`, `authenticated`,
 * and derived scope/capability metadata are exposed to routes/tools/UI.
 */
export async function getGitHubAuthDiagnostics(
  settings: Record<string, unknown>,
  options: ResolveGitHubAuthOptions & ScopeProbeOptions = {},
): Promise<GitHubAuthDiagnostics> {
  const auth = await resolveGitHubAuth(settings, options);
  if (!auth.authenticated || !auth.token) {
    return unauthenticatedDiagnostics();
  }

  const probe = await probeGitHubScopesCached(auth.token, options);

  if (probe.status === "auth-error") {
    return {
      authenticated: false,
      source: auth.source,
      introspectable: false,
      probeStatus: probe.status,
      capabilities: { issues: "unknown", discussions: "unknown", projects: "unknown" },
      missingProjectScope: false,
      warning: {
        message: "The resolved GitHub token was rejected (401). It may be expired or revoked.",
        instructions: [
          "Re-run 'gh auth login', or",
          "Refresh the GITHUB_TOKEN environment variable, or",
          "Generate a new personal access token and update it in Plugin Manager settings.",
        ],
      },
    };
  }

  if (probe.status === "network-error") {
    return {
      authenticated: true,
      source: auth.source,
      introspectable: false,
      probeStatus: probe.status,
      capabilities: { issues: "unknown", discussions: "unknown", projects: "unknown" },
      missingProjectScope: false,
      warning: {
        message: "Could not reach GitHub to check token scopes. Capability support is unknown for now.",
        instructions: ["Check network connectivity and retry the diagnostics panel."],
      },
    };
  }

  const introspectable = probe.status === "ok";
  const capabilities = mapScopesToCapabilities(probe);
  const missingProjectScope = introspectable && capabilities.projects === "missing";

  let warning: GitHubAuthDiagnostics["warning"];
  if (missingProjectScope) {
    warning = {
      message: "This token lacks the 'project' scope, so Projects v2 boards are unavailable.",
      instructions: [
        "Open https://github.com/settings/tokens and edit or create a personal access token.",
        "For a classic PAT, enable the 'project' scope. For a fine-grained PAT, grant the 'Projects' repository/account permission.",
        "Paste the token into the GitHub PM plugin's 'GitHub personal access token' setting to override the ambient gh CLI/env token.",
      ],
    };
  } else if (!introspectable) {
    warning = {
      message: "This token's classic scopes cannot be introspected (fine-grained PAT or GitHub App token). Projects v2 support is unknown, not confirmed missing.",
      instructions: [
        "Grant the 'Projects' permission explicitly when creating/editing this fine-grained token if you need Projects v2 access.",
      ],
    };
  }

  return {
    authenticated: true,
    source: auth.source,
    introspectable,
    probeStatus: probe.status,
    capabilities,
    missingProjectScope,
    warning,
  };
}
