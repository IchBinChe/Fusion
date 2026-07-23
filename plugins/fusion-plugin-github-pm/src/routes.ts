import type { PluginContext, PluginRouteDefinition, PluginRouteResponse } from "@fusion/plugin-sdk";
import { hasPersonalAccessToken, resolveGitHubPmSettings } from "./settings.js";
import { getGitHubAuthDiagnostics } from "./auth.js";
import { repoConfigRoutes } from "./repo-config-routes.js";
import { taxonomyRoutes } from "./taxonomy-routes.js";
import { issueRoutes } from "./issue-routes.js";
import { issuesRoutes } from "./issues-routes.js";

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

/*
FNXC:GithubPmAuth 2026-07-24-00:20:
FUSI-002 Step 3: expose the layered-auth diagnostics payload built in auth.ts over
/auth/diagnostics. The response body carries only `source`/`authenticated`/derived
capability metadata -- never the resolved token/PAT value -- per the plugin's
credential-hygiene requirement (mirrors the linear-import sanitizer FNXC note).
*/
export async function getGitHubAuthDiagnosticsRoute(_req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const diagnostics = await getGitHubAuthDiagnostics(ctx.settings);
  return response(200, { ok: true, ...diagnostics });
}

/*
FNXC:GithubPmRepoConfig 2026-07-24-00:00:
FUSI-004 adds the per-repo config routes (GET/PUT /repo-config, PUT
/repo-config/select) onto the plugin's aggregated route list so index.ts stays
a single registration point (mirrors the linear-import precedent of one
route-array export per plugin).
*/
/*
FNXC:GithubPmTaxonomy 2026-07-24-00:20:
FUSI-005 adds the taxonomy proposal review routes (POST /taxonomy/propose, GET
/taxonomy/proposals, PUT /taxonomy/proposals/accept|reject|edit) onto the same
aggregated route list, following the FUSI-004 precedent of one route-array export
per plugin feature spread into githubPmRoutes.
*/
/*
FNXC:GithubPmIssues 2026-07-24-01:10:
FUSI-013 adds the read-only issue-detail routes (GET /issues/detail, GET
/issues/comments) onto the same aggregated route list, following the same
one-route-array-export-per-feature precedent.

FNXC:GithubPmIssues 2026-07-24-03:15:
FUSI-012 adds the read-only issues-list routes (list/search + filter-option lookups) onto the
aggregated route list, same one-registration-point pattern as repoConfigRoutes.
*/
export const githubPmRoutes: PluginRouteDefinition[] = [
  { method: "GET", path: "/status", handler: getGitHubPmStatus, description: "Report GitHub PM plugin configuration status from settings presence only." },
  { method: "GET", path: "/auth/diagnostics", handler: getGitHubAuthDiagnosticsRoute, description: "Resolve the layered GitHub auth chain and report per-capability scope diagnostics (never the token value)." },
  ...repoConfigRoutes,
  ...taxonomyRoutes,
  ...issueRoutes,
  ...issuesRoutes,
];
