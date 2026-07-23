import type { PluginContext, PluginRouteDefinition, PluginRouteResponse } from "@fusion/plugin-sdk";
import { GitHubClient, buildDiscussionSearchQuery, githubErrorToResponse } from "./github-client.js";
import { resolveGitHubAuth } from "./auth.js";
import { normalizeRepoKey, resolveSelectedRepo } from "./repo-config.js";
import { resolveGitHubPmSettings } from "./settings.js";

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
  body?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readQuery(req: unknown): Record<string, unknown> {
  return asRecord((req as RequestLike).query);
}

function readBody(req: unknown): Record<string, unknown> {
  return asRecord((req as RequestLike).body);
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

/*
FNXC:GithubPmWriteGate 2026-07-25-14:05:
KB-006's ONE write route in this file (`postDiscussionComment`). Mirrors
issue-write-routes.ts's `requireConfirmation` exactly: resolves `confirmWrites` via
`resolveGitHubPmSettings(ctx.settings)` and, when ON, requires an explicit `body.confirmed ===
true`; otherwise returns a 400 `confirmation_required` response BEFORE `requireClient`/any
client.* call runs, so an unconfirmed post-comment request performs ZERO auth resolution and
ZERO GitHub API calls -- same invariant every other write route in this plugin establishes.
*/
function requireConfirmation(body: Record<string, unknown>, ctx: PluginContext): PluginRouteResponse | null {
  const settings = resolveGitHubPmSettings(ctx.settings);
  if (!settings.confirmWrites) return null;
  if (body.confirmed === true) return null;
  return response(400, {
    ok: false,
    error: "This write requires confirmation. Re-send with confirmed:true, or disable 'Confirm writes' in GitHub PM plugin settings.",
    code: "confirmation_required",
  });
}

function parseDiscussionNumberParam(value: unknown): number | null {
  const num = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(num) && num > 0 ? num : null;
}

function readCursor(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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

/*
FNXC:GithubPmDiscussions 2026-07-25-14:10:
KB-006 discussion DETAIL + lazy-pagination + post-comment routes, extending the KB-005
discussion-browse routes above in the SAME file (one route-array export per feature, extended
rather than duplicated). `GET /discussions/detail` mirrors issue-routes.ts's
bundle-the-first-page shape (the discussion plus its first top-level comment page, each
comment already carrying its own first reply page); `GET /discussions/comments` and
`GET /discussions/replies` serve subsequent pages ONE AT A TIME via cursor so a long thread
lazy-loads from the view rather than the client eagerly accumulating every page up front --
the same lazy-pagination contract issue-routes.ts established for issue comments.
`POST /discussions/comments` is this file's first (and only) WRITE route: the shared
`requireConfirmation` gate above runs BEFORE `requireClient`/any client call, mirroring
issue-write-routes.ts's ordering exactly.
*/

/**
 * GET /discussions/detail?repo=&number= — the DiscussionDetailView's single fetch-on-mount
 * call: the discussion itself plus the first page of top-level comments (each already
 * carrying its own first reply page) plus cursors for lazy comment/reply pagination. A
 * discussion that GitHub resolves to nothing (bad number, or repo has no such discussion)
 * maps to a 404 `not_found`; any other GitHub error (auth/scope/graphql) is surfaced via
 * `githubErrorToResponse` rather than degraded to an empty shape -- there is no meaningful
 * "empty detail" to render.
 */
export async function getDiscussionDetailRoute(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const query = readQuery(req);
  const repo = resolveRepoParam(ctx, query);
  const number = parseDiscussionNumberParam(query.number);
  if (!repo || number === null) {
    return response(400, { ok: false, error: "repo must be an owner/repo string (or a repo must be selected), and number must be a positive integer.", code: "validation_error" });
  }

  const client = await requireClient(ctx);
  if (isRouteResponse(client)) return client;

  const [owner, name] = splitOwnerRepo(repo);
  try {
    const discussion = await client.getDiscussionDetail(owner, name, number);
    if (!discussion) {
      return response(404, { ok: false, error: `Discussion #${number} was not found in ${repo}.`, code: "not_found" });
    }
    return response(200, { ok: true, repo, discussion });
  } catch (error) {
    const mapped = githubErrorToResponse(error);
    return response(mapped.status, { ok: false, error: mapped.error, code: mapped.code });
  }
}

/** GET /discussions/comments?repo=&number=&after= — lazy subsequent top-level comment page. */
export async function getDiscussionCommentsRoute(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const query = readQuery(req);
  const repo = resolveRepoParam(ctx, query);
  const number = parseDiscussionNumberParam(query.number);
  if (!repo || number === null) {
    return response(400, { ok: false, error: "repo must be an owner/repo string (or a repo must be selected), and number must be a positive integer.", code: "validation_error" });
  }
  const after = readCursor(query.after);

  const client = await requireClient(ctx);
  if (isRouteResponse(client)) return client;

  const [owner, name] = splitOwnerRepo(repo);
  try {
    const page = await client.listDiscussionComments(owner, name, number, { after });
    return response(200, { ok: true, repo, comments: page.comments, nextCursor: page.nextCursor });
  } catch (error) {
    const mapped = githubErrorToResponse(error);
    return response(mapped.status, { ok: false, error: mapped.error, code: mapped.code });
  }
}

/** GET /discussions/replies?commentId=&after= — lazy subsequent reply page for ONE top-level comment, addressed by its GraphQL node id (no repo/number needed — replies are scoped to their parent comment). */
export async function getDiscussionRepliesRoute(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const query = readQuery(req);
  const commentId = readString(query.commentId);
  if (!commentId) {
    return response(400, { ok: false, error: "commentId is required.", code: "validation_error" });
  }
  const after = readCursor(query.after);

  const client = await requireClient(ctx);
  if (isRouteResponse(client)) return client;

  try {
    const page = await client.listDiscussionCommentReplies(commentId, { after });
    return response(200, { ok: true, commentId, replies: page.replies, nextCursor: page.nextCursor });
  } catch (error) {
    const mapped = githubErrorToResponse(error);
    return response(mapped.status, { ok: false, error: mapped.error, code: mapped.code });
  }
}

/**
 * POST /discussions/comments { repo?, discussionId, body, replyToId?, confirmed? } — post a NEW
 * top-level comment (no `replyToId`) or a nested reply under `replyToId` (a top-level comment's
 * GraphQL node id). `repo` is accepted for parity with every other write route in this plugin
 * but is not required by the underlying mutation (GitHub's `addDiscussionComment` is addressed
 * entirely by `discussionId`/`replyToId` node ids, not owner/repo/number).
 */
export async function postDiscussionComment(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const body = readBody(req);
  const discussionId = readString(body.discussionId);
  const commentBody = readString(body.body);
  if (!discussionId || !commentBody) {
    return response(400, { ok: false, error: "discussionId and a non-empty body are required.", code: "validation_error" });
  }
  const replyToId = readString(body.replyToId);

  const confirmationBlocked = requireConfirmation(body, ctx);
  if (confirmationBlocked) return confirmationBlocked;

  const client = await requireClient(ctx);
  if (isRouteResponse(client)) return client;

  try {
    const comment = await client.addDiscussionComment({ discussionId, body: commentBody, replyToId });
    return response(200, { ok: true, comment });
  } catch (error) {
    const mapped = githubErrorToResponse(error);
    return response(mapped.status, { ok: false, error: mapped.error, code: mapped.code });
  }
}

export const discussionRoutes: PluginRouteDefinition[] = [
  { method: "GET", path: "/discussions/categories", handler: getDiscussionCategories, description: "List a repository's discussion categories (id/name/slug/emoji/isAnswerable) for the discussion browser's category rail." },
  { method: "GET", path: "/discussions/list", handler: getDiscussionsList, description: "Browse/search a repository's discussions via GitHub's search(type: DISCUSSION) connection, filtered by category/search/sort/answered." },
  { method: "GET", path: "/discussions/detail", handler: getDiscussionDetailRoute, description: "Read-only: fetch a discussion's full detail and the first page of its two-level comment/reply thread." },
  { method: "GET", path: "/discussions/comments", handler: getDiscussionCommentsRoute, description: "Read-only: fetch a subsequent page of a discussion's top-level comments." },
  { method: "GET", path: "/discussions/replies", handler: getDiscussionRepliesRoute, description: "Read-only: fetch a subsequent page of a single top-level comment's replies." },
  { method: "POST", path: "/discussions/comments", handler: postDiscussionComment, description: "Post a new top-level discussion comment, or a nested reply when replyToId is supplied." },
];
