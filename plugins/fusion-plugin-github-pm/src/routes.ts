import type { PluginContext, PluginRouteDefinition, PluginRouteResponse } from "@fusion/plugin-sdk";
import { hasPersonalAccessToken, resolveGitHubPmSettings } from "./settings.js";

function response(status: number, body: Record<string, unknown>): PluginRouteResponse {
  return { status, body };
}

/*
FNXC:GitHubPm 2026-07-24-00:00:
Scaffold-only /status route (FUSI-001). Reports configured/not-configured purely
from settings presence -- no gh CLI call, no GITHUB_TOKEN check, no live GitHub
API request, and never echoes the PAT value. FUSI-002 extends this with real
auth probing and scope diagnostics.
*/
export async function getGitHubPmStatus(_req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const settings = resolveGitHubPmSettings(ctx.settings);
  return response(200, {
    ok: true,
    configured: hasPersonalAccessToken(ctx.settings) || Boolean(settings.defaultRepo),
    autonomy: settings.defaultAutonomy,
    defaultRepo: settings.defaultRepo ?? null,
  });
}

export const githubPmRoutes: PluginRouteDefinition[] = [
  { method: "GET", path: "/status", handler: getGitHubPmStatus, description: "Report GitHub PM plugin configuration status from settings presence only." },
];
