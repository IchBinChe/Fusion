import type { PluginSettingSchema } from "@fusion/plugin-sdk";

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
};

export type GitHubPmAutonomy = "approve-all" | "suggest" | "auto";

export interface GitHubPmPluginSettings {
  personalAccessToken?: string;
  defaultRepo?: string;
  defaultAutonomy: GitHubPmAutonomy;
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
  };
}

export function hasPersonalAccessToken(settings: Record<string, unknown>): boolean {
  return Boolean(resolveGitHubPmSettings(settings).personalAccessToken);
}
