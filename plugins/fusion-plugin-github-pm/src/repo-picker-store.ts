import { normalizeRepoKey } from "./repo-config.js";

/*
FNXC:GitHubPmRepoPicker 2026-07-24-07:15:
FUSI-007 requirement: persist a recently-used-repo list for the repo picker so switching
repos doesn't force re-typing/re-searching every time, and it survives a Fusion restart.
Mirrors repo-config.ts's FUSI-004 contract exactly: plugins have no bespoke KV/data-dir API,
so this is stored as a SERIALIZED-JSON STRING setting (RECENT_REPOS_SETTING_ID) in the
plugin's settings blob (central.plugin_installs.settings via PluginStore.updatePluginSettings).
Decoding is corruption-tolerant by design: undefined, non-string, empty-string, or malformed
JSON all degrade to an empty array -- this module must never throw on read. The list is
capped at RECENT_REPOS_CAP (10) most-recently-used entries; recording an already-present repo
dedupes it (case-insensitively, via normalizeRepoKey) and moves it to the front rather than
growing the list. No secret/credential material is ever stored here.
*/

/** Maximum number of recent repos retained. Selecting an 11th repo evicts the oldest. */
export const RECENT_REPOS_CAP = 10;

/** Plugin setting id holding the serialized-JSON RecentRepoEntry[] list. Plugin-managed, not hand-edited. */
export const RECENT_REPOS_SETTING_ID = "recentRepos";

export interface RecentRepoEntry {
  /** Canonical lowercase "owner/repo". */
  repo: string;
  /** ISO timestamp of the most recent selection. */
  lastUsedAt: string;
}

function coerceRecentRepoEntry(value: unknown): RecentRepoEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const repo = normalizeRepoKey(record.repo);
  if (!repo) return null;
  const lastUsedAt = typeof record.lastUsedAt === "string" && !Number.isNaN(new Date(record.lastUsedAt).getTime())
    ? record.lastUsedAt
    : new Date(0).toISOString();
  return { repo, lastUsedAt };
}

/**
 * Decode the serialized-JSON recent-repos list. Corruption-tolerant: undefined/non-string/
 * empty-string/malformed-JSON/non-array all resolve to `[]`. Malformed entries are dropped
 * individually rather than discarding the whole list; the result is truncated to the cap.
 */
export function parseRecentRepos(raw: unknown): RecentRepoEntry[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const entries: RecentRepoEntry[] = [];
  for (const item of parsed) {
    const entry = coerceRecentRepoEntry(item);
    if (entry) entries.push(entry);
  }
  return entries.slice(0, RECENT_REPOS_CAP);
}

/** Read the recent-repos list directly off a plugin settings record. */
export function parseRecentReposFromSettings(settings: Record<string, unknown>): RecentRepoEntry[] {
  return parseRecentRepos(settings?.[RECENT_REPOS_SETTING_ID]);
}

/** Deterministic JSON serialization for the string setting. */
export function serializeRecentRepos(entries: RecentRepoEntry[]): string {
  return JSON.stringify(entries);
}

/**
 * Return a NEW list with `repo` recorded as the most-recently-used entry: any existing entry
 * for the same (case-insensitively normalized) repo is removed, then the repo is placed at
 * the front with a fresh `lastUsedAt`, and the result is capped at RECENT_REPOS_CAP (oldest
 * entries evicted first). Never mutates the input list. An invalid repo is a no-op that
 * returns the original list reference unchanged.
 */
export function recordRecentRepo(entries: RecentRepoEntry[], repo: string, now: Date = new Date()): RecentRepoEntry[] {
  const normalized = normalizeRepoKey(repo);
  if (!normalized) return entries;
  const withoutExisting = entries.filter((entry) => entry.repo !== normalized);
  const next: RecentRepoEntry[] = [{ repo: normalized, lastUsedAt: now.toISOString() }, ...withoutExisting];
  return next.slice(0, RECENT_REPOS_CAP);
}
