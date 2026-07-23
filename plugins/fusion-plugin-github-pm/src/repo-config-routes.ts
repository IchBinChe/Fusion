import type { PluginContext, PluginRouteDefinition, PluginRouteResponse } from "@fusion/plugin-sdk";
import {
  REPO_CONFIG_STATE_SETTING_ID,
  SELECTED_REPO_SETTING_ID,
  normalizeRepoKey,
  parseRepoConfigsFromSettings,
  resolveRepoConfig,
  resolveSelectedRepo,
  serializeRepoConfigs,
  upsertRepoConfig,
  type RepoConfig,
} from "./repo-config.js";

interface RequestLike {
  body?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readBody(req: unknown): Record<string, unknown> {
  return asRecord((req as RequestLike).body);
}

function response(status: number, body: Record<string, unknown>): PluginRouteResponse {
  return { status, body };
}

/**
 * Minimal shape of the durable PluginStore write surface this module relies
 * on. Kept narrow (rather than importing the concrete PluginStore class) so
 * unit tests can supply a lightweight fake without pulling in @fusion/core.
 */
interface PluginSettingsWriter {
  updatePluginSettings(pluginId: string, settings: Record<string, unknown>): Promise<unknown>;
}

interface PluginStoreCapableTaskStore {
  getPluginStore?: () => PluginSettingsWriter;
}

/*
FNXC:GithubPmRepoConfig 2026-07-24-00:00:
Durable-settings-blob contract (restated at the persistence boundary): the
ONLY write path for per-repo state is
ctx.taskStore.getPluginStore().updatePluginSettings(ctx.pluginId, { ... }).
updatePluginSettings MERGES onto the existing settings row in
central.plugin_installs.settings (PostgreSQL-backed), so it survives a Fusion
restart -- there is no in-memory fallback and no filesystem/data-dir store.
getPluginStore() is defensively probed rather than assumed: if it is missing
(e.g. a stripped-down test TaskStore) the write routes fail closed with a
stable 500 code instead of throwing.
*/
function requirePluginStore(ctx: PluginContext): PluginSettingsWriter | PluginRouteResponse {
  const taskStore = ctx.taskStore as unknown as PluginStoreCapableTaskStore;
  if (typeof taskStore?.getPluginStore !== "function") {
    ctx.logger.error("github-pm repo-config: ctx.taskStore.getPluginStore is unavailable");
    return response(500, { ok: false, error: "Plugin storage is unavailable.", code: "plugin_store_unavailable" });
  }
  return taskStore.getPluginStore();
}

function isRouteResponse(value: PluginSettingsWriter | PluginRouteResponse): value is PluginRouteResponse {
  return typeof (value as PluginRouteResponse).status === "number";
}

/** GET /repo-config — read-only: selected repo, its resolved config, and the full map. No writes. */
export async function getRepoConfig(_req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const repoConfigs = parseRepoConfigsFromSettings(ctx.settings);
  const selectedRepo = resolveSelectedRepo(ctx.settings);
  const config = selectedRepo ? resolveRepoConfig(repoConfigs, selectedRepo) : null;
  return response(200, { ok: true, selectedRepo, config, repoConfigs });
}

/** PUT /repo-config — upsert one repo's config (autonomy/taxonomy/view prefs) and persist it. */
export async function putRepoConfig(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const body = readBody(req);
  const repo = normalizeRepoKey(body.repo);
  if (!repo) return response(400, { ok: false, error: "repo must be an owner/repo string.", code: "validation_error" });

  const store = requirePluginStore(ctx);
  if (isRouteResponse(store)) return store;

  const patch = asRecord(body.config) as Partial<RepoConfig>;
  const currentMap = parseRepoConfigsFromSettings(ctx.settings);
  const nextMap = upsertRepoConfig(currentMap, repo, patch);

  try {
    await store.updatePluginSettings(ctx.pluginId, {
      [REPO_CONFIG_STATE_SETTING_ID]: serializeRepoConfigs(nextMap),
    });
  } catch (error) {
    ctx.logger.error("github-pm repo-config: failed to persist repo config", error);
    return response(500, { ok: false, error: "Failed to persist repo configuration.", code: "persist_failed" });
  }

  return response(200, { ok: true, repo, config: resolveRepoConfig(nextMap, repo) });
}

/**
 * PUT /repo-config/select — persist the last-selected repo AND ensure a
 * config row exists for it (defaults upserted if absent), in one write so
 * selecting a never-before-configured repo doesn't need a second round-trip.
 */
export async function selectRepoConfig(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const body = readBody(req);
  const repo = normalizeRepoKey(body.repo);
  if (!repo) return response(400, { ok: false, error: "repo must be an owner/repo string.", code: "validation_error" });

  const store = requirePluginStore(ctx);
  if (isRouteResponse(store)) return store;

  const currentMap = parseRepoConfigsFromSettings(ctx.settings);
  const nextMap = currentMap[repo] ? currentMap : upsertRepoConfig(currentMap, repo, {});

  try {
    await store.updatePluginSettings(ctx.pluginId, {
      [SELECTED_REPO_SETTING_ID]: repo,
      [REPO_CONFIG_STATE_SETTING_ID]: serializeRepoConfigs(nextMap),
    });
  } catch (error) {
    ctx.logger.error("github-pm repo-config: failed to persist repo selection", error);
    return response(500, { ok: false, error: "Failed to persist repo selection.", code: "persist_failed" });
  }

  return response(200, { ok: true, selectedRepo: repo, config: resolveRepoConfig(nextMap, repo) });
}

export const repoConfigRoutes: PluginRouteDefinition[] = [
  { method: "GET", path: "/repo-config", handler: getRepoConfig, description: "Read the selected repo and full per-repo configuration map from plugin settings." },
  { method: "PUT", path: "/repo-config", handler: putRepoConfig, description: "Upsert a repo's autonomy mode, taxonomy version, and view preferences into the durable settings blob." },
  { method: "PUT", path: "/repo-config/select", handler: selectRepoConfig, description: "Persist the last-selected repository and ensure a default config row exists for it." },
];
