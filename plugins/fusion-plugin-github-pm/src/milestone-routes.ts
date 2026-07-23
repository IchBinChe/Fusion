import type { PluginContext, PluginRouteDefinition, PluginRouteResponse } from "@fusion/plugin-sdk";
import { GitHubClient, githubErrorToResponse, isGitHubApiError } from "./github-client.js";
import { resolveGitHubAuth } from "./auth.js";
import { normalizeRepoKey, resolveSelectedRepo } from "./repo-config.js";
import { resolveGitHubPmSettings } from "./settings.js";

/*
FNXC:GithubPmMilestones 2026-07-25-00:30:
KB-003 milestone routes. Mirrors issue-write-routes.ts's exact route shape (resolveRepoParam:
explicit repo (query for the read route, body for writes) -> resolveSelectedRepo(ctx.settings)
fallback; requireClient(ctx) auth-gate returning a 401 route-response; the shared
requireConfirmation write guard resolved and enforced BEFORE any auth/client call; try/catch
mapping via githubErrorToResponse) and issues-routes.ts's read-route shape (GET with a query
string, degrading to an empty list rather than an error when no repo resolves). Delete is a
`POST /milestones/delete` (body-carried), not an HTTP DELETE route, per this task's explicit
routing guidance -- the plugin route registrar's proven surface here is GET for reads and
POST/PUT for writes.
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

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Distinguishes "not provided" (undefined) from "explicitly null" (clear) from a supplied string value. */
function readNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === "string") return value;
  return undefined;
}

function readPositiveInt(value: unknown): number | null {
  const num = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(num) && num > 0 ? num : null;
}

function readStateFilter(value: unknown): "open" | "closed" | "all" | undefined {
  const raw = readString(value);
  return raw === "open" || raw === "closed" || raw === "all" ? raw : undefined;
}

function response(status: number, body: Record<string, unknown>): PluginRouteResponse {
  return { status, body };
}

function resolveRepoParam(source: Record<string, unknown>, ctx: PluginContext): string | null {
  return normalizeRepoKey(source.repo) ?? resolveSelectedRepo(ctx.settings);
}

function splitOwnerRepo(repo: string): [string, string] {
  const [owner, name] = repo.split("/");
  return [owner, name];
}

/*
FNXC:GithubPmWriteGate 2026-07-25-00:30:
FUSI-017's shared write guard, mirrored verbatim from issue-write-routes.ts: resolves
confirmWrites via resolveGitHubPmSettings(ctx.settings) and, when ON, requires an explicit
body.confirmed === true; otherwise returns a 400 confirmation_required response. Called from
every one of the 5 write handlers below BEFORE requireClient/any client.* call, so an
unconfirmed request performs ZERO auth resolution and ZERO GitHub API calls. The read route
(getMilestonesList) is deliberately NOT gated.
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
  ctx.logger.error(`github-pm milestone-routes: ${label} failed unexpectedly`, error);
  return response(500, { ok: false, error: `${label} failed unexpectedly.`, code: "unexpected_error" });
}

/** GET /milestones/list?repo?&state? — mirrors getIssuesFilterOptions' "no repo -> empty list, not an error" degrade. */
export async function getMilestonesList(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const query = readQuery(req);
  const repo = resolveRepoParam(query, ctx);
  if (!repo) {
    return response(200, { ok: true, repo: null, items: [] });
  }

  const client = await requireClient(ctx);
  if (isRouteResponse(client)) return client;

  const [owner, name] = splitOwnerRepo(repo);
  try {
    const items = await client.listMilestones(owner, name, { state: readStateFilter(query.state) });
    return response(200, { ok: true, repo, items });
  } catch (error) {
    return unexpectedError(ctx, "Milestones list", error);
  }
}

/** POST /milestones/create { repo?, title, description?, dueOn?, state?, confirmed? } */
export async function postMilestoneCreate(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const body = readBody(req);
  const repo = resolveRepoParam(body, ctx);
  const title = readString(body.title);
  if (!repo || !title) {
    return response(400, { ok: false, error: "repo (or a selected repo) and a non-empty title are required.", code: "validation_error" });
  }
  const state = body.state === "closed" ? "closed" : body.state === "open" ? "open" : undefined;
  if (body.state !== undefined && state === undefined) {
    return response(400, { ok: false, error: "state must be 'open' or 'closed' when supplied.", code: "validation_error" });
  }

  const confirmationBlocked = requireConfirmation(body, ctx);
  if (confirmationBlocked) return confirmationBlocked;

  const client = await requireClient(ctx);
  if (isRouteResponse(client)) return client;

  const [owner, name] = splitOwnerRepo(repo);
  try {
    const milestone = await client.createMilestone(owner, name, {
      title,
      description: readOptionalString(body.description),
      dueOn: readOptionalString(body.dueOn),
      state,
    });
    return response(200, { ok: true, repo, milestone });
  } catch (error) {
    return unexpectedError(ctx, "Milestone create", error);
  }
}

/** PUT /milestones/update { repo?, number, title?, description?, dueOn? (string | null to clear) } */
export async function putMilestoneUpdate(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const body = readBody(req);
  const repo = resolveRepoParam(body, ctx);
  const number = readPositiveInt(body.number);
  const title = readOptionalString(body.title);
  const description = readOptionalString(body.description);
  const dueOn = readNullableString(body.dueOn);
  if (!repo || number === null) {
    return response(400, { ok: false, error: "repo (or a selected repo) and a positive integer number are required.", code: "validation_error" });
  }
  if (title === undefined && description === undefined && dueOn === undefined) {
    return response(400, { ok: false, error: "At least one of title, description, or dueOn must be supplied.", code: "validation_error" });
  }

  const confirmationBlocked = requireConfirmation(body, ctx);
  if (confirmationBlocked) return confirmationBlocked;

  const client = await requireClient(ctx);
  if (isRouteResponse(client)) return client;

  const [owner, name] = splitOwnerRepo(repo);
  try {
    const milestone = await client.updateMilestone(owner, name, number, { title, description, dueOn });
    return response(200, { ok: true, repo, milestone });
  } catch (error) {
    return unexpectedError(ctx, "Milestone update", error);
  }
}

/** PUT /milestones/state { repo?, number, state } — close or reopen. */
export async function putMilestoneState(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const body = readBody(req);
  const repo = resolveRepoParam(body, ctx);
  const number = readPositiveInt(body.number);
  const state = readString(body.state);
  if (!repo || number === null || (state !== "open" && state !== "closed")) {
    return response(400, { ok: false, error: "repo (or a selected repo), a positive integer number, and state 'open' or 'closed' are required.", code: "validation_error" });
  }

  const confirmationBlocked = requireConfirmation(body, ctx);
  if (confirmationBlocked) return confirmationBlocked;

  const client = await requireClient(ctx);
  if (isRouteResponse(client)) return client;

  const [owner, name] = splitOwnerRepo(repo);
  try {
    const milestone = await client.setMilestoneState(owner, name, number, { state });
    return response(200, { ok: true, repo, milestone });
  } catch (error) {
    return unexpectedError(ctx, "Milestone state change", error);
  }
}

/** POST /milestones/delete { repo?, number, confirmed? } — GitHub detaches (does not cascade-delete) the milestone's issues. */
export async function postMilestoneDelete(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const body = readBody(req);
  const repo = resolveRepoParam(body, ctx);
  const number = readPositiveInt(body.number);
  if (!repo || number === null) {
    return response(400, { ok: false, error: "repo (or a selected repo) and a positive integer number are required.", code: "validation_error" });
  }

  const confirmationBlocked = requireConfirmation(body, ctx);
  if (confirmationBlocked) return confirmationBlocked;

  const client = await requireClient(ctx);
  if (isRouteResponse(client)) return client;

  const [owner, name] = splitOwnerRepo(repo);
  try {
    await client.deleteMilestone(owner, name, number);
    return response(200, { ok: true, repo, number });
  } catch (error) {
    return unexpectedError(ctx, "Milestone delete", error);
  }
}

/*
FNXC:GithubPmMilestones 2026-07-25-00:35:
KB-003 close-with-open-issues support: `target` is a positive integer milestone number to MOVE
the milestone's open issues to, `null` to CLEAR the milestone from them, or omitted to leave
the reassignment step a no-op (the UI only calls this route when the operator actually chose a
reassignment option; "keep assigned" never calls this route at all). GitHub has no bulk
reassignment API, so this iterates `listOpenIssuesForMilestone` and PATCHes each issue in turn.
*/
export async function postMilestoneReassignOpenIssues(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const body = readBody(req);
  const repo = resolveRepoParam(body, ctx);
  const number = readPositiveInt(body.number);
  if (!repo || number === null) {
    return response(400, { ok: false, error: "repo (or a selected repo) and a positive integer number are required.", code: "validation_error" });
  }
  const hasTarget = Object.prototype.hasOwnProperty.call(body, "target");
  let targetMilestone: number | null = null;
  if (hasTarget && body.target !== null) {
    const parsedTarget = readPositiveInt(body.target);
    if (parsedTarget === null) {
      return response(400, { ok: false, error: "target must be a positive integer milestone number, or null to clear.", code: "validation_error" });
    }
    targetMilestone = parsedTarget;
  }

  const confirmationBlocked = requireConfirmation(body, ctx);
  if (confirmationBlocked) return confirmationBlocked;

  const client = await requireClient(ctx);
  if (isRouteResponse(client)) return client;

  const [owner, name] = splitOwnerRepo(repo);
  try {
    const openIssues = await client.listOpenIssuesForMilestone(owner, name, number);
    for (const issue of openIssues) {
      await client.setIssueMilestone(owner, name, issue.number, targetMilestone);
    }
    return response(200, { ok: true, repo, milestoneNumber: number, reassignedCount: openIssues.length, targetMilestone });
  } catch (error) {
    return unexpectedError(ctx, "Milestone open-issue reassignment", error);
  }
}

export const milestoneRoutes: PluginRouteDefinition[] = [
  { method: "GET", path: "/milestones/list", handler: getMilestonesList, description: "List a repository's milestones with progress counts and due dates." },
  { method: "POST", path: "/milestones/create", handler: postMilestoneCreate, description: "Create a new milestone and return GitHub's authoritative created object." },
  { method: "PUT", path: "/milestones/update", handler: putMilestoneUpdate, description: "Edit a milestone's title/description/due date and return GitHub's authoritative updated object." },
  { method: "PUT", path: "/milestones/state", handler: putMilestoneState, description: "Close or reopen a milestone." },
  { method: "POST", path: "/milestones/delete", handler: postMilestoneDelete, description: "Delete a milestone (detaches it from issues; does not delete the issues)." },
  { method: "POST", path: "/milestones/reassign-open-issues", handler: postMilestoneReassignOpenIssues, description: "Clear or move a milestone's open issues to another milestone, used ahead of a close-with-open-issues confirmation." },
];
