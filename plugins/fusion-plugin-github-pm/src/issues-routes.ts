import type { PluginContext, PluginRouteDefinition, PluginRouteResponse } from "@fusion/plugin-sdk";
import { GitHubClient, githubErrorToResponse } from "./github-client.js";
import { resolveGitHubAuth } from "./auth.js";
import { normalizeRepoKey, resolveSelectedRepo } from "./repo-config.js";

/*
FNXC:GithubPmIssues 2026-07-24-03:15:
FUSI-012 issues routes: `GET /issues/list` (dispatches to the plain REST issues-list path or
the Search API path depending on whether a free-text `search` term is present) and
`GET /issues/filter-options` (labels + milestones for the filter dropdowns). Mirrors the
`repo-config-routes.ts`/linear-import `routes.ts` pattern: repo resolves from the `repo` query
param, falling back to `resolveSelectedRepo(ctx.settings)`; auth resolves EXCLUSIVELY through
`resolveGitHubAuth` (never process.env.GITHUB_TOKEN / a second `gh` shellout); errors map
through `githubErrorToResponse`. The token is never echoed in any response body.
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

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readStateFilter(value: unknown): "open" | "closed" | "all" | undefined {
  const raw = readString(value);
  return raw === "open" || raw === "closed" || raw === "all" ? raw : undefined;
}

function readSort(value: unknown): "created" | "updated" | "comments" | undefined {
  const raw = readString(value);
  return raw === "created" || raw === "updated" || raw === "comments" ? raw : undefined;
}

function readDirection(value: unknown): "asc" | "desc" | undefined {
  const raw = readString(value);
  return raw === "asc" || raw === "desc" ? raw : undefined;
}

function response(status: number, body: Record<string, unknown>): PluginRouteResponse {
  return { status, body };
}

/**
 * Resolve the target owner/repo for a request: explicit `repo` query param first, falling back
 * to the plugin's persisted `resolveSelectedRepo(ctx.settings)` (FUSI-004), mirroring
 * `resolveRepoParam` conventions elsewhere in the plugin. Returns null when neither resolves.
 */
function resolveRepoParam(ctx: PluginContext, query: Record<string, unknown>): string | null {
  return normalizeRepoKey(query.repo) ?? resolveSelectedRepo(ctx.settings);
}

function splitOwnerRepo(repo: string): [string, string] {
  const [owner, name] = repo.split("/");
  return [owner, name];
}

async function requireClient(ctx: PluginContext): Promise<GitHubClient | PluginRouteResponse> {
  const auth = await resolveGitHubAuth(ctx.settings);
  if (!auth.authenticated || !auth.token) {
    return response(401, { ok: false, authenticated: false, error: "GitHub PM is not authenticated. Configure gh CLI, GITHUB_TOKEN, or a plugin PAT.", code: "not_authenticated" });
  }
  return new GitHubClient(auth.token);
}

function isRouteResponse(value: GitHubClient | PluginRouteResponse): value is PluginRouteResponse {
  return typeof (value as PluginRouteResponse).status === "number";
}

/**
 * GET /issues/list — dispatches to the Search API path when `search` is non-empty, otherwise
 * the plain page-at-a-time REST issues-list path. Both response shapes carry the same
 * `GitHubIssueSummary[]` `items` array so the panel renders them identically.
 */
export async function getIssuesList(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const query = readQuery(req);
  const repo = resolveRepoParam(ctx, query);
  if (!repo) {
    return response(200, { ok: true, repo: null, mode: "list", items: [], page: 1, perPage: 25, hasNextPage: false });
  }

  const page = readNumber(query.page) ?? 1;
  const perPage = readNumber(query.perPage) ?? 25;
  if (!Number.isFinite(page) || page <= 0) return response(400, { ok: false, error: "page must be a positive number.", code: "validation_error" });
  if (!Number.isFinite(perPage) || perPage <= 0) return response(400, { ok: false, error: "perPage must be a positive number.", code: "validation_error" });

  const client = await requireClient(ctx);
  if (isRouteResponse(client)) return client;

  const [owner, name] = splitOwnerRepo(repo);
  const search = readString(query.search);

  try {
    if (search) {
      const page1 = await client.searchIssues(owner, name, {
        q: search,
        state: readStateFilter(query.state),
        labels: readString(query.labels),
        assignee: readString(query.assignee),
        milestone: readString(query.milestone),
        sort: readSort(query.sort),
        order: readDirection(query.direction),
        page,
        perPage,
      });
      return response(200, {
        ok: true,
        repo,
        mode: "search",
        items: page1.items,
        page: page1.page,
        perPage,
        hasNextPage: page1.hasNextPage,
        nextPage: page1.nextPage,
        totalCount: page1.totalCount,
        incompleteResults: page1.incompleteResults,
        cappedAtLimit: page1.cappedAtLimit,
      });
    }

    const listPage = await client.listIssuesPage(owner, name, {
      state: readStateFilter(query.state),
      labels: readString(query.labels),
      assignee: readString(query.assignee),
      milestone: readString(query.milestone),
      sort: readSort(query.sort),
      direction: readDirection(query.direction),
      page,
      perPage,
    });
    return response(200, {
      ok: true,
      repo,
      mode: "list",
      items: listPage.items,
      page: listPage.page,
      perPage,
      hasNextPage: listPage.hasNextPage,
      nextPage: listPage.nextPage,
    });
  } catch (error) {
    const mapped = githubErrorToResponse(error);
    return response(mapped.status, { ok: false, error: mapped.error, code: mapped.code });
  }
}

/** GET /issues/filter-options — labels (via the existing `listLabels`) + milestones for the filter dropdowns. */
export async function getIssuesFilterOptions(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const query = readQuery(req);
  const repo = resolveRepoParam(ctx, query);
  if (!repo) {
    return response(200, { ok: true, repo: null, labels: [], milestones: [] });
  }

  const client = await requireClient(ctx);
  if (isRouteResponse(client)) return client;

  const [owner, name] = splitOwnerRepo(repo);
  try {
    const [labels, milestones] = await Promise.all([
      client.listLabels(owner, name).catch((error) => {
        // A missing-scope/permission error degrades to an empty list rather than a hard failure,
        // so one dropdown's failure doesn't block the other or the whole panel.
        if (githubErrorToResponse(error).status === 403 || githubErrorToResponse(error).status === 401) return [];
        throw error;
      }),
      client.listMilestones(owner, name).catch((error) => {
        if (githubErrorToResponse(error).status === 403 || githubErrorToResponse(error).status === 401) return [];
        throw error;
      }),
    ]);
    return response(200, { ok: true, repo, labels, milestones });
  } catch (error) {
    const mapped = githubErrorToResponse(error);
    return response(mapped.status, { ok: false, error: mapped.error, code: mapped.code });
  }
}

export const issuesRoutes: PluginRouteDefinition[] = [
  { method: "GET", path: "/issues/list", handler: getIssuesList, description: "List/search repository issues with combinable filters, sort, and page-at-a-time pagination." },
  { method: "GET", path: "/issues/filter-options", handler: getIssuesFilterOptions, description: "Fetch labels and milestones to populate the issue-list filter dropdowns." },
];
