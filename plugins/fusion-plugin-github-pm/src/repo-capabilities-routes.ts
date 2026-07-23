import type { PluginContext, PluginRouteDefinition, PluginRouteResponse } from "@fusion/plugin-sdk";
import { normalizeRepoKey, resolveSelectedRepo } from "./repo-config.js";
import { resolveRepoCapabilities } from "./repo-capabilities.js";

/*
FNXC:GithubPmCapabilities 2026-07-24-08:10:
FUSI-009 route: `GET /repo/capabilities` is the ONLY HTTP surface for the per-repo tab
capability model -- the client hook (useRepoCapabilities.ts) and pure mapper
(tab-capabilities.ts) consume this route's response rather than re-deriving gating
themselves. Repo resolution mirrors `issues-routes.ts`'s `resolveRepoParam` precedent:
explicit `repo` query param first, falling back to FUSI-004's `resolveSelectedRepo`. An
invalid/absent repo is a 400 validation_error BEFORE any auth/GitHub call is made
(mirroring `repo-config-routes.ts`'s validate-before-touching-anything shape). The token
is never echoed -- `resolveRepoCapabilities`'s output already excludes it by construction.
*/

interface RequestLike {
  query?: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readQuery(req: unknown): Record<string, unknown> {
  return asRecord((req as RequestLike).query);
}

function response(status: number, body: Record<string, unknown>): PluginRouteResponse {
  return { status, body };
}

/** GET /repo/capabilities — resolve the per-tab capability model for the target repo. */
export async function getRepoCapabilities(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const query = readQuery(req);
  const repo = normalizeRepoKey(query.repo) ?? resolveSelectedRepo(ctx.settings);
  if (!repo) {
    return response(400, { ok: false, error: "repo must be an owner/repo string (or a repo must already be selected).", code: "validation_error" });
  }

  const capabilities = await resolveRepoCapabilities(ctx.settings, repo);
  return response(200, { ok: true, ...capabilities });
}

export const repoCapabilitiesRoutes: PluginRouteDefinition[] = [
  { method: "GET", path: "/repo/capabilities", handler: getRepoCapabilities, description: "Resolve which GitHub PM tabs the selected repo and resolved token can support, with reasons and fix paths for disabled tabs." },
];
