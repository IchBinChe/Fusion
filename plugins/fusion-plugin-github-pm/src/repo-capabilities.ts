import { getGitHubAuthDiagnostics, resolveGitHubAuth, type GitHubAuthDiagnostics, type ResolveGitHubAuthOptions, type ScopeProbeOptions } from "./auth.js";
import { GitHubClient, isGitHubApiError, type GitHubRepositoryFeatures } from "./github-client.js";
import { normalizeRepoKey } from "./repo-config.js";

/*
FNXC:GithubPmCapabilities 2026-07-24-08:00:
FUSI-009 mission: after a repo is selected, compose TWO independent signals into one
per-tab gating model so the tab shell never has to reason about auth/scope/repo-feature
state itself: (1) repo feature flags (Issues/Discussions enabled), read via
`GitHubClient.getRepositoryFeatures` (ONE cheap GraphQL call); and (2) token scope
capabilities, read via `getGitHubAuthDiagnostics` (FUSI-002's SINGLE capability source --
this module never re-probes scopes on its own). `resolveRepoCapabilities` below is the
ONLY place these two signals are composed; the tab-capabilities mapper (tab-capabilities.ts)
and the useRepoCapabilities hook just consume its output. Three invariants this module must
never violate: (a) it NEVER throws -- every failure mode (unauthenticated, repo 404/403,
network error) degrades to a typed result the caller can render; (b) it NEVER includes the
resolved token or a raw/redacted GitHub API error string in its output, only reason/message/
fix metadata; (c) a token whose classic scopes cannot be introspected (fine-grained PAT /
GitHub App token -- GitHubCapabilities state "unknown") must resolve to an AVAILABLE tab
with an informational note, never a false "missing" block.
*/

/** The six GitHub PM Foundation-milestone tab surfaces this resolver gates. */
export const REPO_CAPABILITY_TAB_IDS = ["issues", "labels", "milestones", "discussions", "projects", "triage"] as const;

export type RepoCapabilityTabId = (typeof REPO_CAPABILITY_TAB_IDS)[number];

export type TabCapabilityReason = "feature-disabled" | "missing-scope" | "unknown" | "not-authenticated" | "repo-access-error";

export interface TabCapability {
  available: boolean;
  reason?: TabCapabilityReason;
  /** Human-readable explanation. Never raw/redacted GitHub API error text. */
  message?: string;
  /** Ordered, actionable remediation steps. */
  fix?: string[];
}

export interface RepoCapabilities {
  repo: string;
  authenticated: boolean;
  tabs: Record<RepoCapabilityTabId, TabCapability>;
}

export interface ResolveRepoCapabilitiesOptions extends ResolveGitHubAuthOptions, ScopeProbeOptions {
  /** Override for tests: constructs the client used for the single repo-features GraphQL read. */
  createClient?: (token: string, fetchImpl?: typeof fetch) => Pick<GitHubClient, "getRepositoryFeatures">;
}

const NOT_AUTHENTICATED_FIX = [
  "Run 'gh auth login' to authenticate the GitHub CLI, or",
  "Set the GITHUB_TOKEN environment variable, or",
  "Add a personal access token in Plugin Manager settings (Authentication group).",
];

function available(): TabCapability {
  return { available: true };
}

function allTabs(entry: TabCapability): Record<RepoCapabilityTabId, TabCapability> {
  return {
    issues: entry,
    labels: entry,
    milestones: entry,
    discussions: entry,
    projects: entry,
    triage: entry,
  };
}

function notAuthenticatedResult(repo: string, diagnostics: GitHubAuthDiagnostics): RepoCapabilities {
  const entry: TabCapability = {
    available: false,
    reason: "not-authenticated",
    message: diagnostics.warning?.message ?? "GitHub PM is not authenticated.",
    fix: diagnostics.warning?.instructions ?? NOT_AUTHENTICATED_FIX,
  };
  return { repo, authenticated: false, tabs: allTabs(entry) };
}

/** Split a normalized "owner/repo" key. Returns nulls when the shape is unexpected (defensive; normalizeRepoKey already guards this upstream). */
function splitRepo(repo: string): [string | null, string | null] {
  const parts = repo.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return [null, null];
  return [parts[0], parts[1]];
}

/** Issues/Discussions feature-disabled notice, per repo Settings → Features. */
function featureDisabledTab(featureLabel: string): TabCapability {
  return {
    available: false,
    reason: "feature-disabled",
    message: `${featureLabel} are not enabled for this repository.`,
    fix: [`Ask the repository owner to enable ${featureLabel} in the repository's Settings → Features.`],
  };
}

const ISSUES_MISSING_SCOPE_FIX = [
  "Open https://github.com/settings/tokens and edit or create a personal access token.",
  "For a classic PAT, enable the 'repo' scope (or 'public_repo' for public repositories only).",
  "Paste the token into the GitHub PM plugin's 'GitHub personal access token' setting to override the ambient gh CLI/env token.",
];

function issuesMissingScopeTab(): TabCapability {
  return {
    available: false,
    reason: "missing-scope",
    message: "This token lacks the scope needed to manage issues.",
    fix: ISSUES_MISSING_SCOPE_FIX,
  };
}

/*
FNXC:GithubPmCapabilities 2026-07-24-08:05:
Projects gating is PURELY token-scope-driven (mission/acceptance criteria only reference the
`project`/`read:project` scope, not a repo-level "Projects enabled" flag) -- so this reuses
FUSI-002's `warning.instructions` fix path verbatim rather than inventing a second one. The
"unknown" (non-introspectable / fine-grained-token) state stays AVAILABLE with an informational
note: never falsely block a tab just because scopes couldn't be read.
*/
function resolveProjectsCapability(diagnostics: GitHubAuthDiagnostics): TabCapability {
  const state = diagnostics.capabilities.projects;
  if (state === "missing") {
    return {
      available: false,
      reason: "missing-scope",
      message: diagnostics.warning?.message ?? "This token lacks the 'project' scope, so Projects v2 boards are unavailable.",
      fix:
        diagnostics.warning?.instructions ?? [
          "Open https://github.com/settings/tokens and edit or create a personal access token.",
          "For a classic PAT, enable the 'project' scope. For a fine-grained PAT, grant the 'Projects' repository/account permission.",
          "Paste the token into the GitHub PM plugin's 'GitHub personal access token' setting to override the ambient gh CLI/env token.",
        ],
    };
  }
  if (state === "unknown") {
    return {
      available: true,
      reason: "unknown",
      message: "This token's scopes can't be confirmed (fine-grained personal access token or GitHub App token). Projects v2 support is unknown, not confirmed missing.",
    };
  }
  return available();
}

const REPO_ACCESS_ERROR_FIX = [
  "Verify the repository owner/name is correct.",
  "Confirm the resolved GitHub token has access to this repository.",
];

function repoAccessErrorTab(): TabCapability {
  return {
    available: false,
    reason: "repo-access-error",
    message: "Could not read this repository's feature settings — it may not exist, or the resolved token lacks access.",
    fix: REPO_ACCESS_ERROR_FIX,
  };
}

function networkDegradedTab(): TabCapability {
  return {
    available: true,
    reason: "unknown",
    message: "Could not verify this repository's feature settings due to a network issue; showing this tab as available for now.",
  };
}

/**
 * Resolve which of the six GitHub PM tabs (issues/labels/milestones/discussions/
 * projects/triage) this specific repo + resolved token can actually support. Composes
 * FUSI-002's per-capability scope diagnostics with a single repo-features GraphQL read.
 * Never throws; never includes the token or a raw GitHub API error string in its output.
 */
export async function resolveRepoCapabilities(
  settings: Record<string, unknown>,
  repoInput: string,
  options: ResolveRepoCapabilitiesOptions = {},
): Promise<RepoCapabilities> {
  const repo = normalizeRepoKey(repoInput) ?? repoInput;

  const diagnostics = await getGitHubAuthDiagnostics(settings, options);
  const auth = await resolveGitHubAuth(settings, options);

  if (!diagnostics.authenticated || !auth.authenticated || !auth.token) {
    return notAuthenticatedResult(repo, diagnostics);
  }

  const tabs: Record<RepoCapabilityTabId, TabCapability> = {
    issues: available(),
    labels: available(),
    milestones: available(),
    discussions: available(),
    projects: resolveProjectsCapability(diagnostics),
    triage: available(),
  };

  const [owner, name] = splitRepo(repo);
  let features: GitHubRepositoryFeatures | undefined;
  if (owner && name) {
    try {
      const client = options.createClient
        ? options.createClient(auth.token, options.fetchImpl)
        : new GitHubClient(auth.token, options.fetchImpl ?? fetch);
      features = await client.getRepositoryFeatures(owner, name);
    } catch (error) {
      if (isGitHubApiError(error) && (error.code === "not_found" || error.code === "auth_error")) {
        tabs.issues = repoAccessErrorTab();
        tabs.discussions = repoAccessErrorTab();
      } else {
        // Network / unexpected error: degrade softly rather than blocking the tab or throwing.
        tabs.issues = networkDegradedTab();
        tabs.discussions = networkDegradedTab();
      }
    }
  } else {
    tabs.issues = repoAccessErrorTab();
    tabs.discussions = repoAccessErrorTab();
  }

  if (features) {
    if (!features.hasIssuesEnabled) tabs.issues = featureDisabledTab("Issues");
    if (!features.hasDiscussionsEnabled) tabs.discussions = featureDisabledTab("Discussions");
  }

  // Token-scope gating for Issues applies only when the repo itself didn't already block it.
  if (tabs.issues.available && diagnostics.capabilities.issues === "missing") {
    tabs.issues = issuesMissingScopeTab();
  }

  return { repo, authenticated: true, tabs };
}
