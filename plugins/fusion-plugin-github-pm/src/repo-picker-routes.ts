import type { PluginContext, PluginRouteDefinition, PluginRouteResponse } from "@fusion/plugin-sdk";
import { GitHubClient, githubErrorToResponse } from "./github-client.js";
import { resolveGitHubAuth } from "./auth.js";
import { SELECTED_REPO_SETTING_ID, normalizeRepoKey } from "./repo-config.js";
import {
  RECENT_REPOS_SETTING_ID,
  parseRecentReposFromSettings,
  recordRecentRepo,
  serializeRecentRepos,
} from "./repo-picker-store.js";

/*
FNXC:GitHubPmRepoPicker 2026-07-24-07:30:
FUSI-007 repo-picker routes: `GET /repo-picker/search` (Search API, dispatched through
GitHubClient.searchRepositories), `GET /repo-picker/recents` (read-only from the settings
blob, no GitHub call), and `POST /repo-picker/select` (validates existence/access via a
single bounded GitHubClient.getRepository lookup, then persists BOTH the selection --
reusing repo-config.ts's SELECTED_REPO_SETTING_ID, never a second selected-repo field -- and
the recents list in ONE atomic updatePluginSettings call). Mirrors repo-config-routes.ts's
requirePluginStore fail-closed pattern exactly: a write route whose ctx.taskStore has no
getPluginStore() returns a stable 500 rather than throwing.
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

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function response(status: number, body: Record<string, unknown>): PluginRouteResponse {
  return { status, body };
}

/**
 * Minimal shape of the durable PluginStore write surface this module relies on. Kept narrow
 * (mirrors repo-config-routes.ts) so unit tests can supply a lightweight fake without pulling
 * in @fusion/core.
 */
interface PluginSettingsWriter {
  updatePluginSettings(pluginId: string, settings: Record<string, unknown>): Promise<unknown>;
}

interface PluginStoreCapableTaskStore {
  getPluginStore?: () => PluginSettingsWriter;
}

function requirePluginStore(ctx: PluginContext): PluginSettingsWriter | PluginRouteResponse {
  const taskStore = ctx.taskStore as unknown as PluginStoreCapableTaskStore;
  if (typeof taskStore?.getPluginStore !== "function") {
    ctx.logger.error("github-pm repo-picker: ctx.taskStore.getPluginStore is unavailable");
    return response(500, { ok: false, error: "Plugin storage is unavailable.", code: "plugin_store_unavailable" });
  }
  return taskStore.getPluginStore();
}

function isRouteResponse(value: unknown): value is PluginRouteResponse {
  return Boolean(value) && typeof (value as PluginRouteResponse).status === "number";
}

async function requireClient(ctx: PluginContext): Promise<GitHubClient | PluginRouteResponse> {
  const auth = await resolveGitHubAuth(ctx.settings);
  if (!auth.authenticated || !auth.token) {
    return response(401, { ok: false, authenticated: false, error: "GitHub PM is not authenticated. Configure gh CLI, GITHUB_TOKEN, or a plugin PAT.", code: "not_authenticated" });
  }
  return new GitHubClient(auth.token);
}

/**
 * GET /repo-picker/search?q= — free-text repo search across public + any org/private repos
 * the resolved token can see. An empty/whitespace-only `q` returns an empty result set (the
 * UI shows recents instead of dispatching a search for an empty query) rather than issuing a
 * request GitHub itself would reject.
 */
export async function getRepoPickerSearch(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const query = readQuery(req);
  const q = readString(query.q);
  if (!q) return response(200, { ok: true, items: [], totalCount: 0, hasNextPage: false });

  const client = await requireClient(ctx);
  if (isRouteResponse(client)) return client;

  const page = readNumber(query.page) ?? 1;
  const perPage = readNumber(query.perPage) ?? 25;

  try {
    const result = await client.searchRepositories(q, { page, perPage });
    return response(200, { ok: true, ...result });
  } catch (error) {
    const mapped = githubErrorToResponse(error);
    return response(mapped.status, { ok: false, error: mapped.error, code: mapped.code });
  }
}

/** GET /repo-picker/recents — read-only recent-repos list, no GitHub call. */
export async function getRepoPickerRecents(_req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const recents = parseRecentReposFromSettings(ctx.settings);
  return response(200, { ok: true, recents });
}

/**
 * POST /repo-picker/select — validate the repo exists and the token can access it (single
 * bounded GET /repos/{owner}/{repo} lookup, never an issue-count/enumeration call), then
 * persist the selection (SELECTED_REPO_SETTING_ID, FUSI-004's field) and update the recents
 * list (dedupe-and-move-to-front, capped) in ONE atomic updatePluginSettings write.
 */
export async function postRepoPickerSelect(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const body = readBody(req);
  const repo = normalizeRepoKey(body.repo);
  if (!repo) return response(400, { ok: false, error: "repo must be an owner/repo string.", code: "validation_error" });

  const client = await requireClient(ctx);
  if (isRouteResponse(client)) return client;

  const [owner, name] = repo.split("/");
  let summary;
  try {
    summary = await client.getRepository(owner, name);
  } catch (error) {
    const mapped = githubErrorToResponse(error);
    // Surface a clear, non-raw-API-shaped message for the two manual-entry failure modes.
    const friendly = mapped.code === "not_found"
      ? `Repository "${repo}" was not found.`
      : mapped.code === "auth_error"
        ? `You don't have access to "${repo}" with the current GitHub credentials.`
        : mapped.error;
    return response(mapped.status, { ok: false, error: friendly, code: mapped.code });
  }

  const store = requirePluginStore(ctx);
  if (isRouteResponse(store)) return store;

  const currentRecents = parseRecentReposFromSettings(ctx.settings);
  const nextRecents = recordRecentRepo(currentRecents, repo);

  try {
    await store.updatePluginSettings(ctx.pluginId, {
      [SELECTED_REPO_SETTING_ID]: repo,
      [RECENT_REPOS_SETTING_ID]: serializeRecentRepos(nextRecents),
    });
  } catch (error) {
    ctx.logger.error("github-pm repo-picker: failed to persist repo selection", error);
    return response(500, { ok: false, error: "Failed to persist repo selection.", code: "persist_failed" });
  }

  return response(200, { ok: true, selectedRepo: repo, repo: summary, recents: nextRecents });
}

export const repoPickerRoutes: PluginRouteDefinition[] = [
  { method: "GET", path: "/repo-picker/search", handler: getRepoPickerSearch, description: "Search repositories the resolved GitHub token can see (public + accessible private/org repos)." },
  { method: "GET", path: "/repo-picker/recents", handler: getRepoPickerRecents, description: "Read the persisted recently-used repository list from plugin settings." },
  { method: "POST", path: "/repo-picker/select", handler: postRepoPickerSelect, description: "Validate a repository exists and is accessible, then persist it as the selected repo and record it in recents." },
];
