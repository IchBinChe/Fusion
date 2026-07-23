import type { PluginContext, PluginRouteDefinition, PluginRouteResponse } from "@fusion/plugin-sdk";
import { GitHubClient, githubErrorToResponse, isGitHubApiError } from "./github-client.js";
import { resolveGitHubAuth } from "./auth.js";
import { normalizeRepoKey, resolveSelectedRepo } from "./repo-config.js";
import { resolveGitHubPmSettings } from "./settings.js";

/*
FNXC:GithubPmIssues 2026-07-24-05:10:
FUSI-014 issue-write routes. Mirrors issues-routes.ts's exact route shape (resolveRepoParam:
explicit body.repo, else resolveSelectedRepo(ctx.settings); requireClient(ctx) auth-gate
returning a 401 route-response; try/catch mapping via githubErrorToResponse) but reads the
request BODY instead of the query string, since every route here is a POST/PUT mutation
(mirrors taxonomy-routes.ts's readBody). Every handler returns GitHub's authoritative
post-mutation object as the round-trip proof -- never a synthesized/optimistic shape.
`notifyIssuesChanged` is NOT called from any handler here: it is a browser-only refresh
signal owned exclusively by IssueWritePanel.tsx after a successful client-side write.
*/

interface RequestLike {
  body?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readBody(req: unknown): Record<string, unknown> {
  return asRecord((req as RequestLike).body);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  return items.length > 0 ? items : undefined;
}

function readPositiveInt(value: unknown): number | null {
  const num = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(num) && num > 0 ? num : null;
}

function response(status: number, body: Record<string, unknown>): PluginRouteResponse {
  return { status, body };
}

function resolveRepoParam(body: Record<string, unknown>, ctx: PluginContext): string | null {
  return normalizeRepoKey(body.repo) ?? resolveSelectedRepo(ctx.settings);
}

function splitOwnerRepo(repo: string): [string, string] {
  const [owner, name] = repo.split("/");
  return [owner, name];
}

/*
FNXC:GithubPmWriteGate 2026-07-24-06:10:
FUSI-017 shared route guard. Resolves confirmWrites via resolveGitHubPmSettings(ctx.settings)
and, when ON, requires an explicit body.confirmed === true; otherwise returns a 400
confirmation_required response. Called from every one of the 5 write handlers BEFORE
requireClient/any client.* call, so an unconfirmed request performs ZERO auth resolution and
ZERO GitHub API calls -- the security invariant this task establishes. Read-only routes
(issue-routes.ts, issues-routes.ts, repo-config-routes.ts, taxonomy-routes.ts) are
deliberately NOT gated; this guard is only ever wired into mutation handlers.
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

async function requireClient(ctx: PluginContext): Promise<GitHubClient | PluginRouteResponse> {
  const auth = await resolveGitHubAuth(ctx.settings);
  if (!auth.authenticated || !auth.token) {
    return response(401, {
      ok: false,
      authenticated: false,
      error: "GitHub PM is not authenticated. Add a PAT in Plugin Manager settings, set GITHUB_TOKEN, or run 'gh auth login'.",
      code: "not_authenticated",
    });
  }
  return new GitHubClient(auth.token);
}

function isRouteResponse(value: GitHubClient | PluginRouteResponse): value is PluginRouteResponse {
  return typeof (value as PluginRouteResponse).status === "number";
}

function unexpectedError(ctx: PluginContext, label: string, error: unknown): PluginRouteResponse {
  if (isGitHubApiError(error)) {
    const mapped = githubErrorToResponse(error);
    return response(mapped.status, { ok: false, error: mapped.error, code: mapped.code });
  }
  ctx.logger.error(`github-pm issue-write: ${label} failed unexpectedly`, error);
  return response(500, { ok: false, error: `${label} failed unexpectedly.`, code: "unexpected_error" });
}

/** POST /issues/create { repo?, title, body?, labels?, assignees?, milestone? } */
export async function postIssueCreate(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const body = readBody(req);
  const repo = resolveRepoParam(body, ctx);
  const title = readString(body.title);
  if (!repo || !title) {
    return response(400, { ok: false, error: "repo (or a selected repo) and a non-empty title are required.", code: "validation_error" });
  }

  const confirmationBlocked = requireConfirmation(body, ctx);
  if (confirmationBlocked) return confirmationBlocked;

  const client = await requireClient(ctx);
  if (isRouteResponse(client)) return client;

  const [owner, repoName] = splitOwnerRepo(repo);
  try {
    const issue = await client.createIssue(owner, repoName, {
      title,
      body: readOptionalString(body.body),
      labels: readStringArray(body.labels),
      assignees: readStringArray(body.assignees),
      milestone: readPositiveInt(body.milestone) ?? undefined,
    });
    return response(200, { ok: true, repo, issue });
  } catch (error) {
    return unexpectedError(ctx, "Issue create", error);
  }
}

/** PUT /issues/update { repo?, number, title?, body? } */
export async function putIssueUpdate(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const body = readBody(req);
  const repo = resolveRepoParam(body, ctx);
  const number = readPositiveInt(body.number);
  const title = readOptionalString(body.title);
  const issueBody = readOptionalString(body.body);
  if (!repo || number === null) {
    return response(400, { ok: false, error: "repo (or a selected repo) and a positive integer number are required.", code: "validation_error" });
  }
  if (title === undefined && issueBody === undefined) {
    return response(400, { ok: false, error: "At least one of title or body must be supplied.", code: "validation_error" });
  }

  const confirmationBlocked = requireConfirmation(body, ctx);
  if (confirmationBlocked) return confirmationBlocked;

  const client = await requireClient(ctx);
  if (isRouteResponse(client)) return client;

  const [owner, repoName] = splitOwnerRepo(repo);
  try {
    const issue = await client.updateIssue(owner, repoName, number, { title, body: issueBody });
    return response(200, { ok: true, repo, issue });
  } catch (error) {
    return unexpectedError(ctx, "Issue update", error);
  }
}

const CLOSE_STATE_REASONS = new Set(["completed", "not_planned"]);

/** PUT /issues/state { repo?, number, state, stateReason? } */
export async function putIssueState(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const body = readBody(req);
  const repo = resolveRepoParam(body, ctx);
  const number = readPositiveInt(body.number);
  const state = readString(body.state);
  if (!repo || number === null || (state !== "open" && state !== "closed")) {
    return response(400, { ok: false, error: "repo (or a selected repo), a positive integer number, and state 'open' or 'closed' are required.", code: "validation_error" });
  }
  const stateReasonRaw = readString(body.stateReason);
  if (stateReasonRaw !== undefined && state === "closed" && !CLOSE_STATE_REASONS.has(stateReasonRaw)) {
    return response(400, { ok: false, error: "stateReason must be 'completed' or 'not_planned' when closing.", code: "validation_error" });
  }

  const confirmationBlocked = requireConfirmation(body, ctx);
  if (confirmationBlocked) return confirmationBlocked;

  const client = await requireClient(ctx);
  if (isRouteResponse(client)) return client;

  const [owner, repoName] = splitOwnerRepo(repo);
  try {
    const issue = await client.setIssueState(owner, repoName, number, {
      state,
      stateReason: stateReasonRaw as "completed" | "not_planned" | "reopened" | undefined,
    });
    return response(200, { ok: true, repo, issue });
  } catch (error) {
    return unexpectedError(ctx, "Issue state change", error);
  }
}

/** POST /issues/comments { repo?, number, body } */
export async function postIssueComment(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const body = readBody(req);
  const repo = resolveRepoParam(body, ctx);
  const number = readPositiveInt(body.number);
  const commentBody = readString(body.body);
  if (!repo || number === null || !commentBody) {
    return response(400, { ok: false, error: "repo (or a selected repo), a positive integer number, and a non-empty body are required.", code: "validation_error" });
  }

  const confirmationBlocked = requireConfirmation(body, ctx);
  if (confirmationBlocked) return confirmationBlocked;

  const client = await requireClient(ctx);
  if (isRouteResponse(client)) return client;

  const [owner, repoName] = splitOwnerRepo(repo);
  try {
    const comment = await client.createIssueComment(owner, repoName, number, commentBody);
    return response(200, { ok: true, repo, issueNumber: number, comment });
  } catch (error) {
    return unexpectedError(ctx, "Issue comment create", error);
  }
}

/** PUT /issues/comments { repo?, commentId, body } */
export async function putIssueComment(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const body = readBody(req);
  const repo = resolveRepoParam(body, ctx);
  const commentId = readPositiveInt(body.commentId);
  const commentBody = readString(body.body);
  if (!repo || commentId === null || !commentBody) {
    return response(400, { ok: false, error: "repo (or a selected repo), a positive integer commentId, and a non-empty body are required.", code: "validation_error" });
  }

  const confirmationBlocked = requireConfirmation(body, ctx);
  if (confirmationBlocked) return confirmationBlocked;

  const client = await requireClient(ctx);
  if (isRouteResponse(client)) return client;

  const [owner, repoName] = splitOwnerRepo(repo);
  try {
    const comment = await client.updateIssueComment(owner, repoName, commentId, commentBody);
    return response(200, { ok: true, repo, comment });
  } catch (error) {
    return unexpectedError(ctx, "Issue comment update", error);
  }
}

export const issueWriteRoutes: PluginRouteDefinition[] = [
  { method: "POST", path: "/issues/create", handler: postIssueCreate, description: "Create a new issue and return GitHub's authoritative created object." },
  { method: "PUT", path: "/issues/update", handler: putIssueUpdate, description: "Edit an issue's title and/or body and return GitHub's authoritative updated object." },
  { method: "PUT", path: "/issues/state", handler: putIssueState, description: "Close (with a completed/not_planned reason) or reopen an issue." },
  { method: "POST", path: "/issues/comments", handler: postIssueComment, description: "Add a comment to an issue and return GitHub's authoritative created comment." },
  { method: "PUT", path: "/issues/comments", handler: putIssueComment, description: "Edit an existing issue comment by comment id." },
];
