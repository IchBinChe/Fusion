import type { PluginContext, PluginRouteDefinition, PluginRouteResponse } from "@fusion/plugin-sdk";
import { GitHubClient, buildDiscussionSearchQuery, githubErrorToResponse } from "./github-client.js";
import { resolveGitHubAuth } from "./auth.js";
import { normalizeRepoKey, resolveSelectedRepo } from "./repo-config.js";

/*
FNXC:GithubPmDiscussions 2026-07-25-11:00:
KB-005 discussion-BROWSE read routes: `GET /discussions/categories` and `GET /discussions/list`.
Mirrors `issues-routes.ts`'s helpers/conventions exactly -- repo resolves from the `repo` query
param, falling back to `resolveSelectedRepo(ctx.settings)`; auth resolves EXCLUSIVELY through
`resolveGitHubAuth` (never `process.env.GITHUB_TOKEN` / a second `gh` shellout); errors map
through `githubErrorToResponse`; the token is never echoed. This is the ONE registration point
for these two routes -- they are spread into `githubPmRoutes` in `routes.ts`. Both routes are
READ-ONLY: no write route, no agent tool, no `confirmWrites` handling is added here (see
KB-005's "Implementation Surface Notes").
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

function readSort(value: unknown): "activity" | "newest" | undefined {
  const raw = readString(value);
  return raw === "activity" || raw === "newest" ? raw : undefined;
}

function readAnswered(value: unknown): "answered" | "unanswered" | undefined {
  const raw = readString(value);
  return raw === "answered" || raw === "unanswered" ? raw : undefined;
}

function response(status: number, body: Record<string, unknown>): PluginRouteResponse {
  return { status, body };
}

/** Resolve the target owner/repo: explicit `repo` query param first, falling back to the persisted selection. Returns null when neither resolves. */
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
 * GET /discussions/categories — every discussion category for the resolved repo (id/name/slug/
 * emoji/emojiHTML/isAnswerable), feeding the browser's category rail. A discussions-disabled or
 * permission error DEGRADES to an empty `categories: []` array (mirroring
 * `getIssuesFilterOptions`'s 403/401 degrade convention) rather than a hard 500 -- the
 * tab-level FUSI-009 gating already communicates the disabled/inaccessible state; this route
 * must never duplicate that check.
 */
export async function getDiscussionCategories(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const query = readQuery(req);
  const repo = resolveRepoParam(ctx, query);
  if (!repo) {
    return response(200, { ok: true, repo: null, categories: [] });
  }

  const client = await requireClient(ctx);
  if (isRouteResponse(client)) return client;

  const [owner, name] = splitOwnerRepo(repo);
  try {
    const categories = await client.listDiscussionCategories(owner, name);
    return response(200, { ok: true, repo, categories });
  } catch (error) {
    const mapped = githubErrorToResponse(error);
    if (mapped.status === 403 || mapped.status === 401 || mapped.status === 404) {
      return response(200, { ok: true, repo, categories: [] });
    }
    return response(mapped.status, { ok: false, error: mapped.error, code: mapped.code });
  }
}

/**
 * GET /discussions/list — browse discussions for the resolved repo via `searchDiscussions`
 * (GitHub's own `search(type: DISCUSSION)` connection), returning `{ items, query }` where
 * `query` echoes the exact search-qualifier string built for this request (useful for the
 * search-fidelity assertion + debugging). `sort`/`answered` query params are validated against
 * their enums; an invalid value is silently ignored (falls back to the method's own default)
 * rather than 400ing, mirroring a tolerant read-route convention.
 */
export async function getDiscussionsList(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const query = readQuery(req);
  const repo = resolveRepoParam(ctx, query);
  if (!repo) {
    return response(200, { ok: true, repo: null, items: [], query: null });
  }

  const client = await requireClient(ctx);
  if (isRouteResponse(client)) return client;

  const [owner, name] = splitOwnerRepo(repo);
  const options = {
    category: readString(query.category),
    search: readString(query.search),
    sort: readSort(query.sort),
    answered: readAnswered(query.answered),
  };
  const builtQuery = buildDiscussionSearchQuery(owner, name, options);
  try {
    const items = await client.searchDiscussions(owner, name, options);
    return response(200, { ok: true, repo, items, query: builtQuery });
  } catch (error) {
    const mapped = githubErrorToResponse(error);
    return response(mapped.status, { ok: false, error: mapped.error, code: mapped.code });
  }
}

export const discussionRoutes: PluginRouteDefinition[] = [
  { method: "GET", path: "/discussions/categories", handler: getDiscussionCategories, description: "List a repository's discussion categories (id/name/slug/emoji/isAnswerable) for the discussion browser's category rail." },
  { method: "GET", path: "/discussions/list", handler: getDiscussionsList, description: "Browse/search a repository's discussions via GitHub's search(type: DISCUSSION) connection, filtered by category/search/sort/answered." },
];
