import { normalizeRepoKey } from "./repo-config.js";
import type { TaxonomyProposal, TaxonomyProposalContent, TaxonomyProposalStatus, TaxonomyProposalSourceStats } from "./taxonomy-proposal.js";

/*
FNXC:GithubPmTaxonomy 2026-07-24-00:10:
FUSI-005 versioned per-repo proposal store. Mirrors repo-config.ts's persistence
contract exactly (see that module's FNXC note for the full rationale): plugins have
no bespoke KV/data-dir API, so the only durable, restart-surviving store a plugin
owns is its settings blob (central.plugin_installs.settings via
PluginStore.updatePluginSettings). PluginSettingType has no object/json variant, so
the per-repo map of proposal history is stored as a SERIALIZED-JSON STRING setting
(TAXONOMY_PROPOSAL_STATE_SETTING_ID). Decoding is corruption-tolerant by design:
undefined, non-string, empty-string, or malformed JSON all degrade to an empty map,
and entries whose repo key fails normalizeRepoKey are dropped -- this module must
never throw on read. No secret/credential material is ever stored here.
*/

/** Plugin setting id holding the serialized-JSON TaxonomyProposalState map. Plugin-managed. */
export const TAXONOMY_PROPOSAL_STATE_SETTING_ID = "taxonomyProposalState";

export interface RepoTaxonomyProposals {
  proposals: TaxonomyProposal[];
}

/** Keyed by canonical lowercase "owner/repo". */
export type TaxonomyProposalStateMap = Record<string, RepoTaxonomyProposals>;

const PROPOSAL_STATUSES: readonly TaxonomyProposalStatus[] = ["draft", "accepted", "rejected"];

function coerceStatus(value: unknown): TaxonomyProposalStatus {
  return typeof value === "string" && (PROPOSAL_STATUSES as readonly string[]).includes(value) ? (value as TaxonomyProposalStatus) : "draft";
}

function coerceVersion(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 1;
}

function coerceGeneratedAt(value: unknown): string {
  if (typeof value === "string" && value.trim() && !Number.isNaN(new Date(value).getTime())) return value;
  return new Date(0).toISOString();
}

function coerceSourceStats(value: unknown): TaxonomyProposalSourceStats {
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const num = (input: unknown) => (typeof input === "number" && Number.isFinite(input) ? input : 0);
  return {
    issueCount: num(record.issueCount),
    discussionCount: num(record.discussionCount),
    existingLabelCount: num(record.existingLabelCount),
  };
}

function coerceOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function coerceContent(value: unknown): TaxonomyProposalContent {
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return {
    labels: Array.isArray(record.labels) ? record.labels.filter((label): label is TaxonomyProposalContent["labels"][number] => Boolean(label && typeof label === "object")) : [],
    fields: Array.isArray(record.fields) ? record.fields.filter((field): field is TaxonomyProposalContent["fields"][number] => Boolean(field && typeof field === "object")) : [],
    categories: Array.isArray(record.categories) ? record.categories.filter((category): category is TaxonomyProposalContent["categories"][number] => Boolean(category && typeof category === "object")) : [],
    rationale: coerceOptionalString(record.rationale),
  };
}

/** Coerce an arbitrary decoded value into a safe, fully-populated TaxonomyProposal. */
function coerceProposal(value: unknown): TaxonomyProposal {
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const content = coerceContent(record);
  return {
    version: coerceVersion(record.version),
    generatedAt: coerceGeneratedAt(record.generatedAt),
    status: coerceStatus(record.status),
    sourceStats: coerceSourceStats(record.sourceStats),
    ...content,
  };
}

function coerceRepoProposals(value: unknown): RepoTaxonomyProposals {
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const proposals = Array.isArray(record.proposals) ? record.proposals.map(coerceProposal) : [];
  return { proposals };
}

/**
 * Decode the serialized-JSON TaxonomyProposalStateMap setting value. Corruption-tolerant:
 * undefined/non-string/empty-string/malformed-JSON/non-object all resolve to an empty map.
 * Entries whose key fails normalizeRepoKey are dropped; every surviving value is coerced
 * back into a safe RepoTaxonomyProposals (never throws).
 */
export function parseTaxonomyState(raw: unknown): TaxonomyProposalStateMap {
  if (typeof raw !== "string" || !raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const out: TaxonomyProposalStateMap = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const normalized = normalizeRepoKey(key);
    if (!normalized) continue;
    out[normalized] = coerceRepoProposals(value);
  }
  return out;
}

/** Read the TaxonomyProposalStateMap directly off a plugin settings record. */
export function parseTaxonomyStateFromSettings(settings: Record<string, unknown>): TaxonomyProposalStateMap {
  return parseTaxonomyState(settings?.[TAXONOMY_PROPOSAL_STATE_SETTING_ID]);
}

/** Deterministic JSON serialization (stable, sorted key order) for the string setting. */
export function serializeTaxonomyState(map: TaxonomyProposalStateMap): string {
  const ordered: TaxonomyProposalStateMap = {};
  for (const key of Object.keys(map).sort()) ordered[key] = map[key];
  return JSON.stringify(ordered);
}

/** Resolve a repo's stored proposals, or an empty list when none is stored / repo is invalid. */
export function getRepoProposals(map: TaxonomyProposalStateMap, repo: string): TaxonomyProposal[] {
  const normalized = normalizeRepoKey(repo);
  if (!normalized) return [];
  return map[normalized]?.proposals ?? [];
}

/** Next version number for a repo: one greater than the max existing version, or 1 for the first draft. */
export function nextProposalVersion(existing: TaxonomyProposal[]): number {
  if (existing.length === 0) return 1;
  return Math.max(...existing.map((proposal) => proposal.version)) + 1;
}

/**
 * Append a new DRAFT proposal for `repo`, assigning the next version and a fresh
 * `generatedAt`. Returns a NEW map (never mutates the input map). Invalid repo keys
 * are a no-op that returns the original map reference unchanged. This is the ONLY
 * function that creates a proposal; it never touches an existing entry's status.
 */
export function appendDraftProposal(map: TaxonomyProposalStateMap, repo: string, payload: TaxonomyProposalContent & { sourceStats: TaxonomyProposalSourceStats }): { map: TaxonomyProposalStateMap; proposal: TaxonomyProposal | null } {
  const normalized = normalizeRepoKey(repo);
  if (!normalized) return { map, proposal: null };

  const existing = map[normalized]?.proposals ?? [];
  const proposal: TaxonomyProposal = {
    version: nextProposalVersion(existing),
    generatedAt: new Date().toISOString(),
    status: "draft",
    sourceStats: payload.sourceStats,
    labels: payload.labels,
    fields: payload.fields,
    categories: payload.categories,
    rationale: payload.rationale,
  };

  return { map: { ...map, [normalized]: { proposals: [...existing, proposal] } }, proposal };
}

/**
 * Replace a draft proposal's editable content (labels/fields/categories/rationale),
 * keeping its status as "draft". Refuses to edit a non-draft version (returns the
 * original map + a null proposal so the caller can surface a 409/400). Never mutates
 * the input map.
 */
export function editDraftProposal(map: TaxonomyProposalStateMap, repo: string, version: number, patch: TaxonomyProposalContent): { map: TaxonomyProposalStateMap; proposal: TaxonomyProposal | null; error?: "not-found" | "not-draft" } {
  const normalized = normalizeRepoKey(repo);
  if (!normalized) return { map, proposal: null, error: "not-found" };
  const existing = map[normalized]?.proposals ?? [];
  const target = existing.find((proposal) => proposal.version === version);
  if (!target) return { map, proposal: null, error: "not-found" };
  if (target.status !== "draft") return { map, proposal: null, error: "not-draft" };

  const updated: TaxonomyProposal = { ...target, labels: patch.labels, fields: patch.fields, categories: patch.categories, rationale: patch.rationale };
  const nextProposals = existing.map((proposal) => (proposal.version === version ? updated : proposal));
  return { map: { ...map, [normalized]: { proposals: nextProposals } }, proposal: updated };
}

/**
 * Set a proposal's status (accept/reject). Immutable -- returns a NEW map, never
 * mutates the input. Unknown repo/version is a no-op returning a null proposal so
 * the caller can surface a 404.
 */
export function setProposalStatus(map: TaxonomyProposalStateMap, repo: string, version: number, status: TaxonomyProposalStatus): { map: TaxonomyProposalStateMap; proposal: TaxonomyProposal | null } {
  const normalized = normalizeRepoKey(repo);
  if (!normalized) return { map, proposal: null };
  const existing = map[normalized]?.proposals ?? [];
  const target = existing.find((proposal) => proposal.version === version);
  if (!target) return { map, proposal: null };

  const updated: TaxonomyProposal = { ...target, status };
  const nextProposals = existing.map((proposal) => (proposal.version === version ? updated : proposal));
  return { map: { ...map, [normalized]: { proposals: nextProposals } }, proposal: updated };
}

/** Look up a single proposal by repo + version, or null when not found / repo is invalid. */
export function getProposal(map: TaxonomyProposalStateMap, repo: string, version: number): TaxonomyProposal | null {
  return getRepoProposals(map, repo).find((proposal) => proposal.version === version) ?? null;
}
