import { describe, expect, it } from "vitest";
import {
  REPO_CONFIG_STATE_SETTING_ID,
  SELECTED_REPO_SETTING_ID,
  defaultRepoConfig,
  normalizeRepoKey,
  parseRepoConfigs,
  parseRepoConfigsFromSettings,
  resolveRepoConfig,
  resolveSelectedRepo,
  serializeRepoConfigs,
  upsertRepoConfig,
  type RepoConfigMap,
} from "../repo-config.js";

describe("normalizeRepoKey", () => {
  it("lowercases and trims owner/repo for case-insensitive identity", () => {
    expect(normalizeRepoKey(" Owner/Repo ")).toBe("owner/repo");
    expect(normalizeRepoKey("owner/repo")).toBe("owner/repo");
  });

  it("rejects malformed input", () => {
    expect(normalizeRepoKey("")).toBeNull();
    expect(normalizeRepoKey("   ")).toBeNull();
    expect(normalizeRepoKey("just-owner")).toBeNull();
    expect(normalizeRepoKey("owner/repo/extra")).toBeNull();
    expect(normalizeRepoKey("owner/")).toBeNull();
    expect(normalizeRepoKey("/repo")).toBeNull();
    expect(normalizeRepoKey("owner/ re po")).toBeNull();
    expect(normalizeRepoKey(undefined)).toBeNull();
    expect(normalizeRepoKey(42)).toBeNull();
    expect(normalizeRepoKey(null)).toBeNull();
  });
});

describe("parseRepoConfigs", () => {
  it("returns {} for undefined, non-string, and empty-string input", () => {
    expect(parseRepoConfigs(undefined)).toEqual({});
    expect(parseRepoConfigs({})).toEqual({});
    expect(parseRepoConfigs("")).toEqual({});
    expect(parseRepoConfigs("   ")).toEqual({});
  });

  it("never throws on malformed JSON, returning {} instead", () => {
    expect(() => parseRepoConfigs("{not valid json")).not.toThrow();
    expect(parseRepoConfigs("{not valid json")).toEqual({});
  });

  it("returns {} for valid JSON that isn't an object map", () => {
    expect(parseRepoConfigs("[1,2,3]")).toEqual({});
    expect(parseRepoConfigs("42")).toEqual({});
    expect(parseRepoConfigs('"a string"')).toEqual({});
  });

  it("parses a populated map and drops malformed keys", () => {
    const raw = JSON.stringify({
      "Owner/Repo": { autonomyMode: "auto", approvedTaxonomyVersion: 3, viewPreferences: { sort: "updated" }, updatedAt: "2026-07-24T00:00:00.000Z" },
      "not-a-valid-key": { autonomyMode: "auto" },
    });
    const parsed = parseRepoConfigs(raw);
    expect(Object.keys(parsed)).toEqual(["owner/repo"]);
    expect(parsed["owner/repo"]).toEqual({
      autonomyMode: "auto",
      approvedTaxonomyVersion: 3,
      viewPreferences: { sort: "updated" },
      updatedAt: "2026-07-24T00:00:00.000Z",
    });
  });

  it("coerces invalid field values back to safe defaults instead of throwing", () => {
    const raw = JSON.stringify({ "owner/repo": { autonomyMode: "not-real", approvedTaxonomyVersion: "not-a-number", viewPreferences: "nope", updatedAt: 12345 } });
    expect(parseRepoConfigs(raw)).toEqual({
      "owner/repo": { autonomyMode: "approve-all", approvedTaxonomyVersion: null, viewPreferences: {}, updatedAt: null },
    });
  });

  it("reads the map directly off a settings record via parseRepoConfigsFromSettings", () => {
    const settings = { [REPO_CONFIG_STATE_SETTING_ID]: JSON.stringify({ "owner/repo": { autonomyMode: "suggest" } }) };
    expect(parseRepoConfigsFromSettings(settings)["owner/repo"]?.autonomyMode).toBe("suggest");
  });
});

describe("serializeRepoConfigs / round-trip", () => {
  it("is stable regardless of insertion order", () => {
    const a: RepoConfigMap = { "b/two": defaultRepoConfig(), "a/one": defaultRepoConfig() };
    const b: RepoConfigMap = { "a/one": defaultRepoConfig(), "b/two": defaultRepoConfig() };
    expect(serializeRepoConfigs(a)).toBe(serializeRepoConfigs(b));
  });

  it("round-trips serialize(parse(x)) === serialize(x) for populated maps", () => {
    let map: RepoConfigMap = {};
    map = upsertRepoConfig(map, "owner/repo", { autonomyMode: "auto", approvedTaxonomyVersion: 2 });
    map = upsertRepoConfig(map, "another/repo", { autonomyMode: "suggest" });
    const serialized = serializeRepoConfigs(map);
    const roundTripped = parseRepoConfigs(serialized);
    expect(serializeRepoConfigs(roundTripped)).toBe(serialized);
  });
});

describe("resolveRepoConfig", () => {
  it("returns defaults for an unstored or invalid repo", () => {
    expect(resolveRepoConfig({}, "owner/repo")).toEqual(defaultRepoConfig());
    expect(resolveRepoConfig({}, "not-valid")).toEqual(defaultRepoConfig());
  });

  it("completes a partially-stored config with defaults", () => {
    const map: RepoConfigMap = { "owner/repo": { autonomyMode: "auto" } as any };
    const resolved = resolveRepoConfig(map, "owner/repo");
    expect(resolved.autonomyMode).toBe("auto");
    expect(resolved.approvedTaxonomyVersion).toBeNull();
    expect(resolved.viewPreferences).toEqual({});
  });
});

describe("upsertRepoConfig", () => {
  it("does not mutate the input map and refreshes updatedAt", () => {
    const original: RepoConfigMap = {};
    const before = JSON.stringify(original);
    const next = upsertRepoConfig(original, "owner/repo", { autonomyMode: "auto" });
    expect(JSON.stringify(original)).toBe(before);
    expect(original).toEqual({});
    expect(next).not.toBe(original);
    expect(next["owner/repo"].autonomyMode).toBe("auto");
    expect(typeof next["owner/repo"].updatedAt).toBe("string");
  });

  it("is a no-op returning the same reference for an invalid repo", () => {
    const original: RepoConfigMap = {};
    const next = upsertRepoConfig(original, "not-valid", { autonomyMode: "auto" });
    expect(next).toBe(original);
  });

  it("merges patches onto an existing config without dropping other fields", () => {
    let map: RepoConfigMap = {};
    map = upsertRepoConfig(map, "owner/repo", { autonomyMode: "auto", approvedTaxonomyVersion: 5 });
    map = upsertRepoConfig(map, "owner/repo", { viewPreferences: { sort: "name" } });
    expect(map["owner/repo"]).toMatchObject({ autonomyMode: "auto", approvedTaxonomyVersion: 5, viewPreferences: { sort: "name" } });
  });

  it("normalizes case so Owner/Repo and owner/repo target the same entry", () => {
    let map: RepoConfigMap = {};
    map = upsertRepoConfig(map, "Owner/Repo", { autonomyMode: "auto" });
    expect(Object.keys(map)).toEqual(["owner/repo"]);
    expect(resolveRepoConfig(map, "owner/REPO").autonomyMode).toBe("auto");
  });
});

describe("resolveSelectedRepo", () => {
  it("returns null when unset or invalid", () => {
    expect(resolveSelectedRepo({})).toBeNull();
    expect(resolveSelectedRepo({ [SELECTED_REPO_SETTING_ID]: "not-valid" })).toBeNull();
  });

  it("canonicalizes a valid selected repo", () => {
    expect(resolveSelectedRepo({ [SELECTED_REPO_SETTING_ID]: "Owner/Repo" })).toBe("owner/repo");
  });
});
