import type { PluginContext, PluginRouteDefinition, PluginRouteResponse } from "@fusion/plugin-sdk";
import { GitHubClient, githubErrorToResponse, isGitHubApiError } from "./github-client.js";
import { resolveGitHubAuth } from "./auth.js";
import { normalizeRepoKey, resolveSelectedRepo } from "./repo-config.js";

/*
FNXC:GithubPmIssues 2026-07-24-01:10:
FUSI-013 issue-detail read routes. Follows taxonomy-routes.ts's exact route shape:
resolveRepoParam (explicit query param, else resolveSelectedRepo) + resolveGitHubAuth
-> new GitHubClient(auth.token) + githubErrorToResponse mapping. These two routes are
READ-ONLY -- no plugin-store write, unlike the taxonomy/repo-config routes -- so there
is no requirePluginStore gate here. GET /issues/detail bundles the issue + timeline +
FIRST comment page in one round trip (what the detail view needs to render on mount);
GET /issues/comments serves subsequent pages one at a time so a long thread lazy-loads
from the UI instead of the client eagerly accumulating every page up front.
*/

const DEFAULT_COMMENTS_PER_PAGE = 30;

interface RequestLike {
  query?: unknown;
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

function resolveRepoParam(query: Record<string, unknown>, ctx: PluginContext): string | null {
  const explicit = normalizeRepoKey(query.repo);
  if (explicit) return explicit;
  return resolveSelectedRepo(ctx.settings);
}

function parseIssueNumberParam(value: unknown): number | null {
  const num = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(num) && num > 0 ? num : null;
}

function parsePageParam(value: unknown, fallback: number): number {
  const num = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

/**
 * GET /issues/detail?repo=&number= — the IssueDetailView's single fetch-on-mount call:
 * resolved issue, its key-event timeline, and the FIRST page of comments (plus the
 * next-page cursor so the view can lazily fetch more via /issues/comments).
 */
export async function getIssueDetail(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const query = readQuery(req);
  const repo = resolveRepoParam(query, ctx);
  const number = parseIssueNumberParam(query.number);
  if (!repo || number === null) {
    return response(400, { ok: false, error: "repo must be an owner/repo string (or a repo must be selected), and number must be a positive integer.", code: "validation_error" });
  }

  const [owner, repoName] = repo.split("/");
  const auth = await resolveGitHubAuth(ctx.settings);
  const client = new GitHubClient(auth.token);

  try {
    const [issue, timeline, commentsPage] = await Promise.all([
      client.getIssue(owner, repoName, number),
      client.listIssueTimeline(owner, repoName, number),
      client.listIssueComments(owner, repoName, number, { page: 1, perPage: DEFAULT_COMMENTS_PER_PAGE }),
    ]);
    return response(200, {
      ok: true,
      repo,
      issue,
      timeline,
      comments: commentsPage.comments,
      commentsNextPage: commentsPage.nextPage,
    });
  } catch (error) {
    if (isGitHubApiError(error)) {
      const mapped = githubErrorToResponse(error);
      return response(mapped.status, { ok: false, error: mapped.error, code: mapped.code });
    }
    ctx.logger.error("github-pm issues: detail fetch failed unexpectedly", error);
    return response(500, { ok: false, error: "Issue detail fetch failed unexpectedly.", code: "unexpected_error" });
  }
}

/** GET /issues/comments?repo=&number=&page= — lazy subsequent comment pages (default page=1). */
export async function getIssueComments(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const query = readQuery(req);
  const repo = resolveRepoParam(query, ctx);
  const number = parseIssueNumberParam(query.number);
  if (!repo || number === null) {
    return response(400, { ok: false, error: "repo must be an owner/repo string (or a repo must be selected), and number must be a positive integer.", code: "validation_error" });
  }
  const page = parsePageParam(query.page, 1);

  const [owner, repoName] = repo.split("/");
  const auth = await resolveGitHubAuth(ctx.settings);
  const client = new GitHubClient(auth.token);

  try {
    const commentsPage = await client.listIssueComments(owner, repoName, number, { page, perPage: DEFAULT_COMMENTS_PER_PAGE });
    return response(200, { ok: true, repo, comments: commentsPage.comments, nextPage: commentsPage.nextPage });
  } catch (error) {
    if (isGitHubApiError(error)) {
      const mapped = githubErrorToResponse(error);
      return response(mapped.status, { ok: false, error: mapped.error, code: mapped.code });
    }
    ctx.logger.error("github-pm issues: comments fetch failed unexpectedly", error);
    return response(500, { ok: false, error: "Issue comments fetch failed unexpectedly.", code: "unexpected_error" });
  }
}

export const issueRoutes: PluginRouteDefinition[] = [
  { method: "GET", path: "/issues/detail", handler: getIssueDetail, description: "Read-only: fetch an issue's full detail, key timeline events, and the first comment page." },
  { method: "GET", path: "/issues/comments", handler: getIssueComments, description: "Read-only: fetch a subsequent page of an issue's comment thread." },
];
