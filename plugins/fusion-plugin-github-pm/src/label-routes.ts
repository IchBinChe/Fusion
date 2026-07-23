import type { PluginContext, PluginRouteDefinition, PluginRouteResponse } from "@fusion/plugin-sdk";
import { GitHubClient, githubErrorToResponse, isGitHubApiError, normalizeGitHubLabelColor } from "./github-client.js";
import { resolveGitHubAuth } from "./auth.js";
import { normalizeRepoKey, resolveSelectedRepo } from "./repo-config.js";
import { resolveGitHubPmSettings } from "./settings.js";

/*
FNXC:GithubPmLabels 2026-07-24-10:20:
KB-002 label management routes. Mirrors issue-write-routes.ts's exact shape (asRecord/readBody,
response(), resolveRepoParam, splitOwnerRepo, requireClient 401 gate, requireConfirmation
called BEFORE requireClient/any client call) and issues-routes.ts's readQuery/degrade-on-403
pattern for the LIST route. Every write handler returns GitHub's authoritative post-mutation
label object as the round-trip proof -- never a synthesized/optimistic shape.
*/

interface RequestLike {
  body?: unknown;
  query?: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readBody(req: unknown): Record<string, unknown> {
  return asRecord((req as RequestLike).body);
}

function readQuery(req: unknown): Record<string, unknown> {
  return asRecord((req as RequestLike).query);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
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
FNXC:GithubPmWriteGate 2026-07-24-10:20:
FUSI-017 shared route guard, copied verbatim from issue-write-routes.ts's requireConfirmation.
Called from every one of the 3 write handlers BEFORE requireClient/any client.* call, so an
unconfirmed request performs ZERO auth resolution and ZERO GitHub API calls. The LIST/usage
read route below is deliberately NOT gated -- reads never require confirmation.
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
  ctx.logger.error(`github-pm label routes: ${label} failed unexpectedly`, error);
  return response(500, { ok: false, error: `${label} failed unexpectedly.`, code: "unexpected_error" });
}

/*
FNXC:GithubPmLabels 2026-07-24-10:20:
KB-002 bounded-concurrency usage-count fan-out: a repo can have dozens/hundreds of labels, so
resolving every label's usage count sequentially would be slow and resolving them all with
Promise.all with no cap could burst past GitHub's rate limit. `USAGE_COUNT_CONCURRENCY` caps
in-flight usage-count requests; a per-label 401/403/rate_limited failure degrades that ONE
label's usageCount to null (mirroring getIssuesFilterOptions' degrade pattern in
issues-routes.ts) rather than failing the whole list.
*/
const USAGE_COUNT_CONCURRENCY = 5;

async function resolveUsageCounts(client: GitHubClient, owner: string, repo: string, names: string[]): Promise<Map<string, number | null>> {
  const results = new Map<string, number | null>();
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= names.length) return;
      const name = names[index];
      try {
        const count = await client.getLabelUsageCount(owner, repo, name);
        results.set(name, count);
      } catch (error) {
        if (isGitHubApiError(error) && (error.code === "auth_error" || error.code === "rate_limited")) {
          results.set(name, null);
        } else {
          throw error;
        }
      }
    }
  }
  const workers = Array.from({ length: Math.min(USAGE_COUNT_CONCURRENCY, names.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/** GET /labels/list — every repo label with its name/color/description and open-issue usage count. NOT gated (read-only). */
export async function getLabelsList(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const query = readQuery(req);
  const repo = resolveRepoParam(query, ctx);
  if (!repo) {
    return response(200, { ok: true, repo: null, labels: [] });
  }

  const client = await requireClient(ctx);
  if (isRouteResponse(client)) return client;

  const [owner, name] = splitOwnerRepo(repo);
  try {
    const labels = await client.listLabelsRest(owner, name);
    const usageCounts = await resolveUsageCounts(client, owner, name, labels.map((label) => label.name));
    return response(200, {
      ok: true,
      repo,
      labels: labels.map((label) => ({ ...label, usageCount: usageCounts.get(label.name) ?? null })),
    });
  } catch (error) {
    return unexpectedError(ctx, "Label list", error);
  }
}

/** POST /labels/create { repo?, name, color, description?, confirmed? } */
export async function postLabelCreate(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const body = readBody(req);
  const repo = resolveRepoParam(body, ctx);
  const name = readString(body.name);
  const color = readString(body.color);
  if (!repo || !name || !color) {
    return response(400, { ok: false, error: "repo (or a selected repo), a non-empty name, and a color are required.", code: "validation_error" });
  }
  const normalizedColor = normalizeGitHubLabelColor(color);
  if (!normalizedColor) {
    return response(400, { ok: false, error: `Invalid label color "${color}". Use six hex digits, e.g. "d73a4a".`, code: "invalid_color" });
  }

  const confirmationBlocked = requireConfirmation(body, ctx);
  if (confirmationBlocked) return confirmationBlocked;

  const client = await requireClient(ctx);
  if (isRouteResponse(client)) return client;

  const [owner, repoName] = splitOwnerRepo(repo);
  try {
    const label = await client.createLabel(owner, repoName, { name, color: normalizedColor, description: readOptionalString(body.description) });
    return response(200, { ok: true, repo, label });
  } catch (error) {
    return unexpectedError(ctx, "Label create", error);
  }
}

/** PUT /labels/update { repo?, name, newName?, color?, description?, confirmed? } */
export async function putLabelUpdate(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const body = readBody(req);
  const repo = resolveRepoParam(body, ctx);
  const name = readString(body.name);
  const newName = readOptionalString(body.newName);
  const color = readOptionalString(body.color);
  const description = readOptionalString(body.description);
  if (!repo || !name) {
    return response(400, { ok: false, error: "repo (or a selected repo) and a non-empty name are required.", code: "validation_error" });
  }
  if (newName === undefined && color === undefined && description === undefined) {
    return response(400, { ok: false, error: "At least one of newName, color, or description must be supplied.", code: "validation_error" });
  }
  let normalizedColor: string | undefined;
  if (color !== undefined) {
    const normalized = normalizeGitHubLabelColor(color);
    if (!normalized) {
      return response(400, { ok: false, error: `Invalid label color "${color}". Use six hex digits, e.g. "d73a4a".`, code: "invalid_color" });
    }
    normalizedColor = normalized;
  }

  const confirmationBlocked = requireConfirmation(body, ctx);
  if (confirmationBlocked) return confirmationBlocked;

  const client = await requireClient(ctx);
  if (isRouteResponse(client)) return client;

  const [owner, repoName] = splitOwnerRepo(repo);
  try {
    const label = await client.updateLabel(owner, repoName, name, { newName, color: normalizedColor, description });
    return response(200, { ok: true, repo, label });
  } catch (error) {
    return unexpectedError(ctx, "Label update", error);
  }
}

/** POST /labels/delete { repo?, name, confirmed? } */
export async function postLabelDelete(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const body = readBody(req);
  const repo = resolveRepoParam(body, ctx);
  const name = readString(body.name);
  if (!repo || !name) {
    return response(400, { ok: false, error: "repo (or a selected repo) and a non-empty name are required.", code: "validation_error" });
  }

  const confirmationBlocked = requireConfirmation(body, ctx);
  if (confirmationBlocked) return confirmationBlocked;

  const client = await requireClient(ctx);
  if (isRouteResponse(client)) return client;

  const [owner, repoName] = splitOwnerRepo(repo);
  try {
    await client.deleteLabel(owner, repoName, name);
    return response(200, { ok: true, repo, deleted: name });
  } catch (error) {
    return unexpectedError(ctx, "Label delete", error);
  }
}

export const labelRoutes: PluginRouteDefinition[] = [
  { method: "GET", path: "/labels/list", handler: getLabelsList, description: "List repository labels with their open-issue usage counts." },
  { method: "POST", path: "/labels/create", handler: postLabelCreate, description: "Create a new label and return GitHub's authoritative created object." },
  { method: "PUT", path: "/labels/update", handler: putLabelUpdate, description: "Rename (via new_name, preserving issue associations), recolor, and/or re-describe a label." },
  { method: "POST", path: "/labels/delete", handler: postLabelDelete, description: "Delete a label." },
];
