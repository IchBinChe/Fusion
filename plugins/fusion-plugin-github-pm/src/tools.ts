import type { PluginContext, PluginToolDefinition, PluginToolResult } from "@fusion/plugin-sdk";
import { hasPersonalAccessToken, resolveGitHubPmSettings } from "./settings.js";

function textResult(text: string, details?: Record<string, unknown>, isError = false): PluginToolResult {
  return { content: [{ type: "text", text }], details, isError };
}

/*
FNXC:GitHubPm 2026-07-24-00:00:
Placeholder tool (FUSI-001) exercising tool registration ahead of real issue
management tools. Reports configured/not-configured from settings presence
only; never returns the PAT value.
*/
export const githubPmStatusTool: PluginToolDefinition = {
  name: "github_pm_status",
  description: "Report whether the GitHub PM plugin has a default repository or personal access token configured.",
  parameters: { type: "object", properties: {}, required: [] },
  execute: async (_params, ctx: PluginContext) => {
    const settings = resolveGitHubPmSettings(ctx.settings);
    const configured = hasPersonalAccessToken(ctx.settings) || Boolean(settings.defaultRepo);
    const text = configured
      ? `GitHub PM is configured (autonomy: ${settings.defaultAutonomy}${settings.defaultRepo ? `, default repo: ${settings.defaultRepo}` : ""}).`
      : "GitHub PM is not configured yet. Add a default repository or personal access token in Plugin Manager settings.";
    return textResult(text, { configured, autonomy: settings.defaultAutonomy, defaultRepo: settings.defaultRepo ?? null });
  },
};

export const githubPmTools: PluginToolDefinition[] = [githubPmStatusTool];
