import type { PluginSettingSchema } from "@fusion/plugin-sdk";
import {
  parseRepoConfigsFromSettings,
  resolveSelectedRepo,
  type RepoConfigMap,
} from "./repo-config.js";

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
  };
}

export function hasPersonalAccessToken(settings: Record<string, unknown>): boolean {
  return Boolean(resolveGitHubPmSettings(settings).personalAccessToken);
}
