/*
FNXC:GithubPmRepoConfig 2026-07-24-00:00:
FUSI-004 requirement: persist per-repo state (last-selected repo, autonomy mode,
approved taxonomy version, view preferences) so switching between repos on the
GitHub PM plugin preserves each repo's own context, and that state survives a
Fusion restart. Plugins have no bespoke KV/data-dir API -- the only durable,
restart-surviving store a plugin owns is its settings blob in
`central.plugin_installs.settings` (see packages/core/src/plugin-store.ts
PluginStore.updatePluginSettings and packages/core/src/async-plugin-store.ts).
PluginSettingType has no object/json variant (packages/core/src/plugin-types.ts),
so the per-repo map is stored as a SERIALIZED-JSON STRING setting
(REPO_CONFIG_STATE_SETTING_ID) and the last selection as a plain string setting
(SELECTED_REPO_SETTING_ID). Decoding is corruption-tolerant by design: undefined,
non-string, empty-string, or malformed JSON all degrade to an empty map -- this
module must never throw on read. No secret/credential material is ever stored
here; the PAT lives in its own password setting owned by FUSI-002.
*/

/** Autonomy spectrum for AI triage on a given repo, from fully human-gated to fully automatic. */
export type RepoAutonomyMode = "approve-all" | "suggest" | "auto";

const REPO_AUTONOMY_MODES: readonly RepoAutonomyMode[] = ["approve-all", "suggest", "auto"];

/** Extensible view-preference bag (sort/filter/groupBy plus forward-compatible extra keys). */
export interface RepoViewPreferences {
  sort?: string;
  filter?: string;
  groupBy?: string;
  [key: string]: string | number | boolean | undefined;
}

export interface RepoConfig {
  autonomyMode: RepoAutonomyMode;
  approvedTaxonomyVersion: number | null;
  viewPreferences: RepoViewPreferences;
  /** ISO timestamp of the last write, or null for a never-persisted default. */
  updatedAt: string | null;
}

/** Keyed by canonical lowercase "owner/repo". */
export type RepoConfigMap = Record<string, RepoConfig>;

/** Plugin setting id holding the last-selected repo, plain string (not secret). */
export const SELECTED_REPO_SETTING_ID = "selectedRepo";

/** Plugin setting id holding the serialized-JSON RepoConfigMap. Plugin-managed, not hand-edited. */
export const REPO_CONFIG_STATE_SETTING_ID = "repoConfigState";

const REPO_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Normalize an "owner/repo" identifier to a canonical, case-insensitive key.
 * Returns null for anything that isn't a well-formed two-segment repo slug.
 */
export function normalizeRepoKey(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const parts = trimmed.split("/");
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo || !REPO_SEGMENT_PATTERN.test(owner) || !REPO_SEGMENT_PATTERN.test(repo)) return null;
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

/** Canonical defaults for a repo that has never been configured. */
export function defaultRepoConfig(): RepoConfig {
  return {
    autonomyMode: "approve-all",
    approvedTaxonomyVersion: null,
    viewPreferences: {},
    updatedAt: null,
  };
}

function coerceAutonomyMode(value: unknown): RepoAutonomyMode {
  return typeof value === "string" && (REPO_AUTONOMY_MODES as readonly string[]).includes(value)
    ? (value as RepoAutonomyMode)
    : "approve-all";
}

function coerceTaxonomyVersion(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function coerceViewPreferences(value: unknown): RepoViewPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: RepoViewPreferences = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") out[key] = raw;
  }
  return out;
}

function coerceUpdatedAt(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return Number.isNaN(new Date(value).getTime()) ? null : value;
}

/** Coerce an arbitrary decoded value into a safe, fully-populated RepoConfig. */
function coerceRepoConfig(value: unknown): RepoConfig {
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return {
    autonomyMode: coerceAutonomyMode(record.autonomyMode),
    approvedTaxonomyVersion: coerceTaxonomyVersion(record.approvedTaxonomyVersion),
    viewPreferences: coerceViewPreferences(record.viewPreferences),
    updatedAt: coerceUpdatedAt(record.updatedAt),
  };
}

/**
 * Decode the serialized-JSON RepoConfigMap setting value. Corruption-tolerant:
 * undefined/non-string/empty-string/malformed-JSON/non-object all resolve to
 * an empty map. Entries whose key fails normalizeRepoKey are dropped; every
 * surviving value is coerced back into a safe RepoConfig (never throws).
 */
export function parseRepoConfigs(raw: unknown): RepoConfigMap {
  if (typeof raw !== "string" || !raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const out: RepoConfigMap = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const normalized = normalizeRepoKey(key);
    if (!normalized) continue;
    out[normalized] = coerceRepoConfig(value);
  }
  return out;
}

/** Read the RepoConfigMap directly off a plugin settings record. */
export function parseRepoConfigsFromSettings(settings: Record<string, unknown>): RepoConfigMap {
  return parseRepoConfigs(settings?.[REPO_CONFIG_STATE_SETTING_ID]);
}

/** Deterministic JSON serialization (stable, sorted key order) for the string setting. */
export function serializeRepoConfigs(map: RepoConfigMap): string {
  const ordered: RepoConfigMap = {};
  for (const key of Object.keys(map).sort()) ordered[key] = map[key];
  return JSON.stringify(ordered);
}

/** Resolve a repo's stored config, or canonical defaults when none is stored / repo is invalid. */
export function resolveRepoConfig(map: RepoConfigMap, repo: string): RepoConfig {
  const normalized = normalizeRepoKey(repo);
  if (!normalized) return defaultRepoConfig();
  const existing = map[normalized];
  if (!existing) return defaultRepoConfig();
  // Merge over defaults so partially-stored/legacy configs are completed.
  return { ...defaultRepoConfig(), ...existing, viewPreferences: { ...existing.viewPreferences } };
}

/**
 * Return a NEW map with `repo`'s config merged from `patch` and updatedAt
 * refreshed. Never mutates the input map. Invalid repo keys are a no-op that
 * returns the original map reference unchanged.
 */
export function upsertRepoConfig(map: RepoConfigMap, repo: string, patch: Partial<RepoConfig>): RepoConfigMap {
  const normalized = normalizeRepoKey(repo);
  if (!normalized) return map;

  const current = map[normalized] ?? defaultRepoConfig();
  const next: RepoConfig = {
    autonomyMode: patch.autonomyMode !== undefined ? coerceAutonomyMode(patch.autonomyMode) : current.autonomyMode,
    approvedTaxonomyVersion: patch.approvedTaxonomyVersion !== undefined
      ? coerceTaxonomyVersion(patch.approvedTaxonomyVersion)
      : current.approvedTaxonomyVersion,
    viewPreferences: patch.viewPreferences !== undefined
      ? { ...current.viewPreferences, ...coerceViewPreferences(patch.viewPreferences) }
      : current.viewPreferences,
    updatedAt: new Date().toISOString(),
  };

  return { ...map, [normalized]: next };
}

/** Read the last-selected repo off a plugin settings record, canonicalized. Null when unset/invalid. */
export function resolveSelectedRepo(settings: Record<string, unknown>): string | null {
  return normalizeRepoKey(settings?.[SELECTED_REPO_SETTING_ID]);
}
