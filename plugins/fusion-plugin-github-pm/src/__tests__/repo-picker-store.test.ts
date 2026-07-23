import { describe, expect, it } from "vitest";
import {
  RECENT_REPOS_CAP,
  RECENT_REPOS_SETTING_ID,
  parseRecentRepos,
  parseRecentReposFromSettings,
  recordRecentRepo,
  serializeRecentRepos,
  type RecentRepoEntry,
} from "../repo-picker-store.js";

describe("parseRecentRepos", () => {
  it("returns [] for undefined, non-string, and empty-string input", () => {
    expect(parseRecentRepos(undefined)).toEqual([]);
    expect(parseRecentRepos({})).toEqual([]);
    expect(parseRecentRepos("")).toEqual([]);
    expect(parseRecentRepos("   ")).toEqual([]);
  });

  it("never throws on malformed JSON, returning [] instead", () => {
    expect(() => parseRecentRepos("{not valid json")).not.toThrow();
    expect(parseRecentRepos("{not valid json")).toEqual([]);
  });

  it("returns [] for valid JSON that isn't an array", () => {
    expect(parseRecentRepos('{"repo":"a/b"}')).toEqual([]);
    expect(parseRecentRepos("42")).toEqual([]);
  });

  it("drops malformed entries but keeps valid ones, canonicalizing repo keys", () => {
    const raw = JSON.stringify([
      { repo: "Owner/Repo", lastUsedAt: "2026-07-24T00:00:00.000Z" },
      { repo: "not-valid" },
      "just-a-string",
      { repo: "owner2/repo2", lastUsedAt: "not-a-date" },
    ]);
    const parsed = parseRecentRepos(raw);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ repo: "owner/repo", lastUsedAt: "2026-07-24T00:00:00.000Z" });
    expect(parsed[1].repo).toBe("owner2/repo2");
  });

  it("truncates a stored list longer than the cap", () => {
    const entries: RecentRepoEntry[] = Array.from({ length: RECENT_REPOS_CAP + 5 }, (_, i) => ({ repo: `owner/repo${i}`, lastUsedAt: new Date().toISOString() }));
    const parsed = parseRecentRepos(serializeRecentRepos(entries));
    expect(parsed).toHaveLength(RECENT_REPOS_CAP);
  });
});

describe("parseRecentReposFromSettings", () => {
  it("reads off the RECENT_REPOS_SETTING_ID key", () => {
    const entries: RecentRepoEntry[] = [{ repo: "owner/repo", lastUsedAt: "2026-07-24T00:00:00.000Z" }];
    const settings = { [RECENT_REPOS_SETTING_ID]: serializeRecentRepos(entries) };
    expect(parseRecentReposFromSettings(settings)).toEqual(entries);
  });

  it("degrades to [] when the setting is absent", () => {
    expect(parseRecentReposFromSettings({})).toEqual([]);
  });
});

describe("recordRecentRepo", () => {
  it("adds a new repo to the front", () => {
    const now = new Date("2026-07-24T00:00:00.000Z");
    const next = recordRecentRepo([], "owner/repo", now);
    expect(next).toEqual([{ repo: "owner/repo", lastUsedAt: now.toISOString() }]);
  });

  it("dedupes case-insensitively and moves the existing entry to the front", () => {
    const older = [
      { repo: "owner/a", lastUsedAt: "2026-07-20T00:00:00.000Z" },
      { repo: "owner/b", lastUsedAt: "2026-07-21T00:00:00.000Z" },
    ];
    const now = new Date("2026-07-24T00:00:00.000Z");
    const next = recordRecentRepo(older, "Owner/A", now);
    expect(next).toEqual([
      { repo: "owner/a", lastUsedAt: now.toISOString() },
      { repo: "owner/b", lastUsedAt: "2026-07-21T00:00:00.000Z" },
    ]);
    // Not duplicated.
    expect(next.filter((e) => e.repo === "owner/a")).toHaveLength(1);
  });

  it("caps the list at RECENT_REPOS_CAP, evicting the oldest", () => {
    let list: RecentRepoEntry[] = [];
    for (let i = 0; i < RECENT_REPOS_CAP + 3; i += 1) {
      list = recordRecentRepo(list, `owner/repo${i}`, new Date(2026, 0, i + 1));
    }
    expect(list).toHaveLength(RECENT_REPOS_CAP);
    // Most-recently-added is at the front; earliest entries evicted.
    expect(list[0].repo).toBe(`owner/repo${RECENT_REPOS_CAP + 2}`);
    expect(list.some((e) => e.repo === "owner/repo0")).toBe(false);
  });

  it("is a no-op for an invalid repo key, returning the same list reference", () => {
    const list: RecentRepoEntry[] = [{ repo: "owner/repo", lastUsedAt: "2026-07-24T00:00:00.000Z" }];
    expect(recordRecentRepo(list, "not-valid")).toBe(list);
  });

  it("never mutates the input list", () => {
    const list: RecentRepoEntry[] = [{ repo: "owner/repo", lastUsedAt: "2026-07-24T00:00:00.000Z" }];
    const snapshot = JSON.stringify(list);
    recordRecentRepo(list, "owner/other");
    expect(JSON.stringify(list)).toBe(snapshot);
  });
});
