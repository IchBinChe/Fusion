import type { PluginSettingSchema } from "@fusion/plugin-sdk";
import {
  parseRepoConfigsFromSettings,
  resolveSelectedRepo,
  type RepoConfigMap,
} from "./repo-config.js";
import { parseTaxonomyStateFromSettings, type TaxonomyProposalStateMap } from "./taxonomy-store.js";
import { parseRecentReposFromSettings, type RecentRepoEntry } from "./repo-picker-store.js";

export const GITHUB_PM_PLUGIN_ID = "fusion-plugin-github-pm";

export const githubPmSettingsSchema: Record<string, PluginSettingSchema> = {
  personalAccessToken: {
    type: "password",
    label: "GitHub personal access token",
    description: "Optional PAT override used only by this plugin for extra scopes (e.g. Projects v2). Auth falls back to the gh CLI or GITHUB_TOKEN when unset.",
    required: false,
    group: "Authentication",
  },
  defaultRepo: {
    type: "string",
    label: "Default repository",
    description: "Optional default repository in owner/repo form to preselect in the repo picker.",
    group: "Defaults",
  },
  defaultAutonomy: {
    type: "enum",
    label: "Default triage autonomy",
    description: "Default AI triage autonomy level for newly configured repositories.",
    enumValues: ["approve-all", "suggest", "auto"],
    defaultValue: "approve-all",
    group: "Defaults",
  },
  /*
  FNXC:GithubPmRepoConfig 2026-07-24-00:00:
  FUSI-004: two plugin-managed settings back the per-repo config store. Neither
  is hand-edited by the user -- selectedRepo is written by the repo picker's
  select action and repoConfigState is a serialized-JSON RepoConfigMap written
  by the upsert/select routes (see repo-config-routes.ts). No secret material
  is ever written into either field.
  */
  selectedRepo: {
    type: "string",
    label: "Last selected repository (plugin-managed)",
    description: "The most recently selected repository in owner/repo form. Written automatically when you switch repos; not intended for manual editing.",
    group: "Repositories",
  },
  repoConfigState: {
    type: "string",
    multiline: true,
    label: "Per-repo configuration state (plugin-managed)",
    description: "Plugin-managed serialized JSON holding each repository's autonomy mode, approved taxonomy version, and view preferences. Not intended for manual editing.",
    group: "Repositories",
  },
  /*
  FNXC:GitHubPmRepoPicker 2026-07-24-07:15:
  FUSI-007: a fourth plugin-managed settings-blob string holds the capped, most-recent-first
  recent-repos list (see repo-picker-store.ts). Mirrors repoConfigState/taxonomyProposalState's
  contract exactly -- serialized JSON, plugin-managed, never hand-edited, no secrets. Kept in
  sync with the equivalent declaration in manifest.json.
  */
  recentRepos: {
    type: "string",
    multiline: true,
    label: "Recently used repositories (plugin-managed)",
    description: "Plugin-managed serialized JSON holding the most recently selected repositories, most-recent-first, capped at 10 entries. Not intended for manual editing.",
    group: "Repositories",
  },
  /*
  FNXC:GithubPmTaxonomy 2026-07-24-00:10:
  FUSI-005: a third plugin-managed settings-blob string holds the versioned taxonomy
  proposal drafts per repo (see taxonomy-store.ts). Mirrors repoConfigState's contract
  exactly -- serialized JSON, plugin-managed, never hand-edited, no secrets. Kept in
  sync with the equivalent declaration in manifest.json.
  */
  taxonomyProposalState: {
    type: "string",
    multiline: true,
    label: "Taxonomy proposal state (plugin-managed)",
    description: "Plugin-managed serialized JSON holding each repository's versioned label/field/category taxonomy proposal drafts. Not intended for manual editing.",
    group: "Repositories",
  },
  /*
  FNXC:GithubPmWriteGate 2026-07-24-06:00:
  FUSI-017 security audit (2026-07-23) found ZERO confirm/dryRun gating anywhere in this
  plugin's write surfaces (5 HTTP routes + 4 agent tools + the IssueWritePanel UI). This
  setting is the single default-ON gate enforced identically across all three layers: a
  write route/tool with confirmWrites resolved ON rejects the mutation (HTTP 400
  confirmation_required / isError tool result) unless the caller explicitly sends
  confirmed:true, with ZERO GitHub calls made before that rejection. Default is ON
  (missing/unset resolves to true) so an operator who never touches this setting is safe
  by default; only an explicit `false` disables the gate.
  */
  confirmWrites: {
    type: "boolean",
    label: "Confirm writes",
    description: "When on (default), every GitHub write (create/edit/comment/close/reopen issue) requires explicit confirmation before it reaches GitHub -- routes and agent tools reject an unconfirmed write, and the UI shows a confirm dialog. Turn off to allow writes to proceed immediately.",
    defaultValue: true,
    group: "Safety",
  },
};

export type GitHubPmAutonomy = "approve-all" | "suggest" | "auto";

export interface GitHubPmPluginSettings {
  personalAccessToken?: string;
  defaultRepo?: string;
  defaultAutonomy: GitHubPmAutonomy;
  /** FUSI-004: last-selected repo, canonicalized (owner/repo, lowercase), or null when unset. */
  selectedRepo: string | null;
  /** FUSI-004: full per-repo config map decoded from the serialized-JSON settings blob. */
  repoConfigs: RepoConfigMap;
  /** FUSI-005: full per-repo taxonomy proposal state decoded from the serialized-JSON settings blob. */
  taxonomyProposals: TaxonomyProposalStateMap;
  /** FUSI-007: capped, most-recent-first recent-repos list decoded from the serialized-JSON settings blob. */
  recentRepos: RecentRepoEntry[];
  /**
   * FNXC:GithubPmWriteGate 2026-07-24-06:00:
   * FUSI-017: default-ON write-confirmation gate. Missing/unset resolves to `true`; only an
   * explicit `false` disables it. See resolveGitHubPmSettings for the exact rule.
   */
  confirmWrites: boolean;
}

function optionalTrimmed(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/*
FNXC:GitHubPm 2026-07-24-00:00:
FUSI-001 scaffolds settings resolution only; FUSI-002 owns real auth resolution
(gh CLI -> GITHUB_TOKEN -> this PAT override) and scope diagnostics. Keep the
raw PAT out of route responses, tool results, task documents, and logs -- this
resolver only trims/validates it, it never echoes it back to a caller.
*/
export function resolveGitHubPmSettings(settings: Record<string, unknown>): GitHubPmPluginSettings {
  const rawAutonomy = optionalTrimmed(settings.defaultAutonomy);
  const defaultAutonomy = rawAutonomy && githubPmSettingsSchema.defaultAutonomy.enumValues?.includes(rawAutonomy)
    ? rawAutonomy as GitHubPmAutonomy
    : "approve-all";

  return {
    personalAccessToken: optionalTrimmed(settings.personalAccessToken),
    defaultRepo: optionalTrimmed(settings.defaultRepo),
    defaultAutonomy,
    selectedRepo: resolveSelectedRepo(settings),
    repoConfigs: parseRepoConfigsFromSettings(settings),
    taxonomyProposals: parseTaxonomyStateFromSettings(settings),
    recentRepos: parseRecentReposFromSettings(settings),
    /*
    FNXC:GithubPmWriteGate 2026-07-24-06:00:
    Missing/unset/anything-other-than-explicit-`false` resolves to ON (true). This is a
    security-invariant default: an operator who never visits plugin settings must still get
    the confirmation gate. Only `settings.confirmWrites === false` turns it off.
    */
    confirmWrites: settings.confirmWrites === false ? false : true,
  };
}

export function hasPersonalAccessToken(settings: Record<string, unknown>): boolean {
  return Boolean(resolveGitHubPmSettings(settings).personalAccessToken);
}
