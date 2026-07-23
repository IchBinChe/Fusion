import type { PluginContext, PluginRouteDefinition, PluginRouteResponse } from "@fusion/plugin-sdk";
import { GitHubClient, githubErrorToResponse, isGitHubApiError } from "./github-client.js";
import { resolveGitHubAuth } from "./auth.js";
import {
  REPO_CONFIG_STATE_SETTING_ID,
  normalizeRepoKey,
  parseRepoConfigsFromSettings,
  resolveRepoConfig,
  resolveSelectedRepo,
  serializeRepoConfigs,
  upsertRepoConfig,
} from "./repo-config.js";
import {
  TAXONOMY_PROPOSAL_STATE_SETTING_ID,
  appendDraftProposal,
  editDraftProposal,
  getRepoProposals,
  parseTaxonomyStateFromSettings,
  serializeTaxonomyState,
  setProposalStatus,
} from "./taxonomy-store.js";
import { generateTaxonomyProposal } from "./taxonomy-proposal.js";
import type { TaxonomyProposalContent } from "./taxonomy-proposal.js";

/*
FNXC:GithubPmTaxonomy 2026-07-24-00:20:
FUSI-005 review routes. Copies repo-config-routes.ts's exact persistence shape:
requirePluginStore(ctx) probes ctx.taskStore.getPluginStore defensively and fails
closed with a stable 500 (plugin_store_unavailable) rather than throwing; every
write goes through ctx.taskStore.getPluginStore().updatePluginSettings(ctx.pluginId,
{...}), which merges onto the durable settings row so it survives a Fusion restart.

NO SILENT APPLY invariant (restated at the route boundary, see taxonomy-proposal.ts
for the full four-invariant note): propose/edit/reject touch ONLY the
taxonomyProposalState setting -- never approvedTaxonomyVersion. The accept route is
the SOLE place in this module (and the whole plugin) that mutates
RepoConfig.approvedTaxonomyVersion, and it does so via upsertRepoConfig + a single
updatePluginSettings call alongside the proposal-state write, so accept is atomic:
a partial write can never mark a proposal accepted without also recording the
version against the repo's config, or vice versa.
*/

interface RequestLike {
  body?: unknown;
  query?: unknown;
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

function response(status: number, body: Record<string, unknown>): PluginRouteResponse {
  return { status, body };
}

interface PluginSettingsWriter {
  updatePluginSettings(pluginId: string, settings: Record<string, unknown>): Promise<unknown>;
}

interface PluginStoreCapableTaskStore {
  getPluginStore?: () => PluginSettingsWriter;
}

function requirePluginStore(ctx: PluginContext): PluginSettingsWriter | PluginRouteResponse {
  const taskStore = ctx.taskStore as unknown as PluginStoreCapableTaskStore;
  if (typeof taskStore?.getPluginStore !== "function") {
    ctx.logger.error("github-pm taxonomy: ctx.taskStore.getPluginStore is unavailable");
    return response(500, { ok: false, error: "Plugin storage is unavailable.", code: "plugin_store_unavailable" });
  }
  return taskStore.getPluginStore();
}

function isRouteResponse(value: PluginSettingsWriter | PluginRouteResponse): value is PluginRouteResponse {
  return typeof (value as PluginRouteResponse).status === "number";
}

function resolveRepoParam(body: Record<string, unknown>, ctx: PluginContext): string | null {
  const explicit = normalizeRepoKey(body.repo);
  if (explicit) return explicit;
  return resolveSelectedRepo(ctx.settings);
}

function taskStoreRootDir(ctx: PluginContext): string {
  const taskStore = ctx.taskStore as unknown as { getRootDir?: () => string };
  return typeof taskStore?.getRootDir === "function" ? taskStore.getRootDir() : process.cwd();
}

function parseVersionParam(value: unknown): number | null {
  const num = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(num) && num > 0 ? num : null;
}

/**
 * POST /taxonomy/propose { repo? } — fetch repo history, run one AI pass through
 * ctx.createAiSession, and persist the result as a new DRAFT. Does NOT touch
 * approvedTaxonomyVersion. Maps GitHub API failures through githubErrorToResponse
 * and generator failures (ai-unavailable/parse-error) to a clear 502.
 */
export async function postTaxonomyPropose(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const body = readBody(req);
  const repo = resolveRepoParam(body, ctx);
  if (!repo) return response(400, { ok: false, error: "repo must be an owner/repo string, or a repo must be selected.", code: "validation_error" });

  const store = requirePluginStore(ctx);
  if (isRouteResponse(store)) return store;

  const [owner, repoName] = repo.split("/");
  const auth = await resolveGitHubAuth(ctx.settings);
  const client = new GitHubClient(auth.token);

  let generated;
  try {
    generated = await generateTaxonomyProposal({
      client,
      owner,
      repo: repoName,
      createAiSession: ctx.createAiSession,
      cwd: taskStoreRootDir(ctx),
    });
  } catch (error) {
    if (isGitHubApiError(error)) {
      const mapped = githubErrorToResponse(error);
      return response(mapped.status, { ok: false, error: mapped.error, code: mapped.code });
    }
    ctx.logger.error("github-pm taxonomy: propose failed unexpectedly", error);
    return response(500, { ok: false, error: "Taxonomy proposal generation failed unexpectedly.", code: "unexpected_error" });
  }

  if (!generated.ok) {
    return response(502, { ok: false, error: generated.message, code: generated.reason });
  }

  const currentMap = parseTaxonomyStateFromSettings(ctx.settings);
  const { map: nextMap, proposal } = appendDraftProposal(currentMap, repo, { ...generated.content, sourceStats: generated.sourceStats });
  if (!proposal) {
    return response(400, { ok: false, error: "repo must be an owner/repo string.", code: "validation_error" });
  }

  try {
    await store.updatePluginSettings(ctx.pluginId, { [TAXONOMY_PROPOSAL_STATE_SETTING_ID]: serializeTaxonomyState(nextMap) });
  } catch (error) {
    ctx.logger.error("github-pm taxonomy: failed to persist proposal draft", error);
    return response(500, { ok: false, error: "Failed to persist taxonomy proposal.", code: "persist_failed" });
  }

  return response(200, { ok: true, repo, proposal });
}

/** GET /taxonomy/proposals?repo= — read-only: proposals + approvedTaxonomyVersion for the selected/given repo. No writes. */
export async function getTaxonomyProposals(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const query = readQuery(req);
  const repo = normalizeRepoKey(query.repo) ?? resolveSelectedRepo(ctx.settings);
  if (!repo) return response(200, { ok: true, repo: null, proposals: [], approvedTaxonomyVersion: null });

  const proposalMap = parseTaxonomyStateFromSettings(ctx.settings);
  const repoConfigMap = parseRepoConfigsFromSettings(ctx.settings);
  const config = resolveRepoConfig(repoConfigMap, repo);
  return response(200, { ok: true, repo, proposals: getRepoProposals(proposalMap, repo), approvedTaxonomyVersion: config.approvedTaxonomyVersion });
}

/**
 * PUT /taxonomy/proposals/accept { repo?, version } — the ONLY route that mutates
 * the active taxonomy: marks `version` accepted in the proposal store AND sets
 * RepoConfig.approvedTaxonomyVersion = version, in a single atomic
 * updatePluginSettings write.
 */
export async function putTaxonomyAccept(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const body = readBody(req);
  const repo = resolveRepoParam(body, ctx);
  const version = parseVersionParam(body.version);
  if (!repo || version === null) return response(400, { ok: false, error: "repo and a positive integer version are required.", code: "validation_error" });

  const store = requirePluginStore(ctx);
  if (isRouteResponse(store)) return store;

  const proposalMap = parseTaxonomyStateFromSettings(ctx.settings);
  const { map: nextProposalMap, proposal } = setProposalStatus(proposalMap, repo, version, "accepted");
  if (!proposal) return response(404, { ok: false, error: `No taxonomy proposal version ${version} found for ${repo}.`, code: "not_found" });

  const repoConfigMap = parseRepoConfigsFromSettings(ctx.settings);
  const nextRepoConfigMap = upsertRepoConfig(repoConfigMap, repo, { approvedTaxonomyVersion: version });

  try {
    await store.updatePluginSettings(ctx.pluginId, {
      [TAXONOMY_PROPOSAL_STATE_SETTING_ID]: serializeTaxonomyState(nextProposalMap),
      [REPO_CONFIG_STATE_SETTING_ID]: serializeRepoConfigs(nextRepoConfigMap),
    });
  } catch (error) {
    ctx.logger.error("github-pm taxonomy: failed to persist proposal acceptance", error);
    return response(500, { ok: false, error: "Failed to persist taxonomy proposal acceptance.", code: "persist_failed" });
  }

  return response(200, { ok: true, repo, proposal, approvedTaxonomyVersion: version });
}

/** PUT /taxonomy/proposals/reject { repo?, version } — marks a version rejected. Does NOT touch approvedTaxonomyVersion. */
export async function putTaxonomyReject(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const body = readBody(req);
  const repo = resolveRepoParam(body, ctx);
  const version = parseVersionParam(body.version);
  if (!repo || version === null) return response(400, { ok: false, error: "repo and a positive integer version are required.", code: "validation_error" });

  const store = requirePluginStore(ctx);
  if (isRouteResponse(store)) return store;

  const proposalMap = parseTaxonomyStateFromSettings(ctx.settings);
  const { map: nextMap, proposal } = setProposalStatus(proposalMap, repo, version, "rejected");
  if (!proposal) return response(404, { ok: false, error: `No taxonomy proposal version ${version} found for ${repo}.`, code: "not_found" });

  try {
    await store.updatePluginSettings(ctx.pluginId, { [TAXONOMY_PROPOSAL_STATE_SETTING_ID]: serializeTaxonomyState(nextMap) });
  } catch (error) {
    ctx.logger.error("github-pm taxonomy: failed to persist proposal rejection", error);
    return response(500, { ok: false, error: "Failed to persist taxonomy proposal rejection.", code: "persist_failed" });
  }

  return response(200, { ok: true, repo, proposal });
}

/** PUT /taxonomy/proposals/edit { repo?, version, proposal } — replaces a draft's editable content; refuses a non-draft version (409). */
export async function putTaxonomyEdit(req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> {
  const body = readBody(req);
  const repo = resolveRepoParam(body, ctx);
  const version = parseVersionParam(body.version);
  if (!repo || version === null) return response(400, { ok: false, error: "repo and a positive integer version are required.", code: "validation_error" });

  const patchRecord = asRecord(body.proposal);
  const patch: TaxonomyProposalContent = {
    labels: Array.isArray(patchRecord.labels) ? patchRecord.labels : [],
    fields: Array.isArray(patchRecord.fields) ? patchRecord.fields : [],
    categories: Array.isArray(patchRecord.categories) ? patchRecord.categories : [],
    rationale: typeof patchRecord.rationale === "string" ? patchRecord.rationale : undefined,
  };

  const store = requirePluginStore(ctx);
  if (isRouteResponse(store)) return store;

  const proposalMap = parseTaxonomyStateFromSettings(ctx.settings);
  const { map: nextMap, proposal, error } = editDraftProposal(proposalMap, repo, version, patch);
  if (error === "not-found") return response(404, { ok: false, error: `No taxonomy proposal version ${version} found for ${repo}.`, code: "not_found" });
  if (error === "not-draft") return response(409, { ok: false, error: `Taxonomy proposal version ${version} is no longer a draft and cannot be edited.`, code: "not_draft" });

  try {
    await store.updatePluginSettings(ctx.pluginId, { [TAXONOMY_PROPOSAL_STATE_SETTING_ID]: serializeTaxonomyState(nextMap) });
  } catch (writeError) {
    ctx.logger.error("github-pm taxonomy: failed to persist proposal edit", writeError);
    return response(500, { ok: false, error: "Failed to persist taxonomy proposal edit.", code: "persist_failed" });
  }

  return response(200, { ok: true, repo, proposal });
}

export const taxonomyRoutes: PluginRouteDefinition[] = [
  { method: "POST", path: "/taxonomy/propose", handler: postTaxonomyPropose, description: "Analyze a repo's issue/discussion/label history and propose a data-driven taxonomy draft (never auto-applied)." },
  { method: "GET", path: "/taxonomy/proposals", handler: getTaxonomyProposals, description: "Read-only: list a repo's taxonomy proposal drafts and its currently accepted version." },
  { method: "PUT", path: "/taxonomy/proposals/accept", handler: putTaxonomyAccept, description: "Accept a taxonomy proposal version, making it the repo's active taxonomy (the only route that mutates approvedTaxonomyVersion)." },
  { method: "PUT", path: "/taxonomy/proposals/reject", handler: putTaxonomyReject, description: "Reject a taxonomy proposal version. Does not change the repo's active taxonomy." },
  { method: "PUT", path: "/taxonomy/proposals/edit", handler: putTaxonomyEdit, description: "Edit a draft taxonomy proposal's content. Refuses to edit an accepted/rejected version." },
];
