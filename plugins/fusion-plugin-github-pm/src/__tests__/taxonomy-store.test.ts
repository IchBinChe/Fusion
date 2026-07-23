import { describe, expect, it } from "vitest";
import {
  appendDraftProposal,
  editDraftProposal,
  getProposal,
  getRepoProposals,
  nextProposalVersion,
  parseTaxonomyState,
  parseTaxonomyStateFromSettings,
  serializeTaxonomyState,
  setProposalStatus,
  TAXONOMY_PROPOSAL_STATE_SETTING_ID,
  type TaxonomyProposalStateMap,
} from "../taxonomy-store.js";
import type { TaxonomyProposalContent, TaxonomyProposalSourceStats } from "../taxonomy-proposal.js";

const STATS: TaxonomyProposalSourceStats = { issueCount: 5, discussionCount: 2, existingLabelCount: 3 };
const CONTENT: TaxonomyProposalContent = { labels: [{ name: "bug" }], fields: [], categories: [{ name: "Bugs" }], rationale: "grounded" };

describe("parseTaxonomyState", () => {
  it("degrades to {} for undefined/non-string/empty/malformed input, never throws", () => {
    expect(parseTaxonomyState(undefined)).toEqual({});
    expect(parseTaxonomyState(42)).toEqual({});
    expect(parseTaxonomyState("")).toEqual({});
    expect(parseTaxonomyState("   ")).toEqual({});
    expect(parseTaxonomyState("{not valid json")).toEqual({});
    expect(parseTaxonomyState("[1,2,3]")).toEqual({});
    expect(parseTaxonomyState("null")).toEqual({});
  });

  it("drops entries whose key fails normalizeRepoKey", () => {
    const state = parseTaxonomyState(JSON.stringify({ "not-a-repo-key": { proposals: [] }, "owner/repo": { proposals: [] } }));
    expect(Object.keys(state)).toEqual(["owner/repo"]);
  });

  it("coerces a malformed proposal entry into a safe default instead of throwing", () => {
    const state = parseTaxonomyState(JSON.stringify({ "owner/repo": { proposals: [{ version: "not-a-number", status: "bogus" }] } }));
    expect(state["owner/repo"].proposals[0]).toMatchObject({ version: 1, status: "draft", labels: [], fields: [], categories: [] });
  });

  it("parseTaxonomyStateFromSettings reads the setting id off a settings record", () => {
    const settings = { [TAXONOMY_PROPOSAL_STATE_SETTING_ID]: JSON.stringify({ "owner/repo": { proposals: [] } }) };
    expect(parseTaxonomyStateFromSettings(settings)).toEqual({ "owner/repo": { proposals: [] } });
  });
});

describe("nextProposalVersion", () => {
  it("returns 1 for an empty list", () => {
    expect(nextProposalVersion([])).toBe(1);
  });

  it("returns max version + 1", () => {
    const proposals = [
      { version: 1, generatedAt: "x", status: "rejected" as const, sourceStats: STATS, ...CONTENT },
      { version: 3, generatedAt: "x", status: "draft" as const, sourceStats: STATS, ...CONTENT },
    ];
    expect(nextProposalVersion(proposals)).toBe(4);
  });
});

describe("appendDraftProposal", () => {
  it("assigns version 1, status draft, and does not mutate the input map", () => {
    const map: TaxonomyProposalStateMap = {};
    const { map: nextMap, proposal } = appendDraftProposal(map, "owner/repo", { ...CONTENT, sourceStats: STATS });
    expect(map).toEqual({});
    expect(proposal).toMatchObject({ version: 1, status: "draft", sourceStats: STATS, labels: CONTENT.labels });
    expect(getRepoProposals(nextMap, "owner/repo")).toHaveLength(1);
  });

  it("increments version across repeated proposals, no duplicate version numbers", () => {
    let map: TaxonomyProposalStateMap = {};
    map = appendDraftProposal(map, "owner/repo", { ...CONTENT, sourceStats: STATS }).map;
    map = appendDraftProposal(map, "owner/repo", { ...CONTENT, sourceStats: STATS }).map;
    const versions = getRepoProposals(map, "owner/repo").map((p) => p.version);
    expect(versions).toEqual([1, 2]);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("is a no-op for an invalid repo key", () => {
    const map: TaxonomyProposalStateMap = {};
    const result = appendDraftProposal(map, "not-valid", { ...CONTENT, sourceStats: STATS });
    expect(result.map).toBe(map);
    expect(result.proposal).toBeNull();
  });
});

describe("setProposalStatus (immutability)", () => {
  it("returns a NEW map and does not mutate the original", () => {
    let map: TaxonomyProposalStateMap = {};
    map = appendDraftProposal(map, "owner/repo", { ...CONTENT, sourceStats: STATS }).map;
    const before = JSON.parse(JSON.stringify(map));

    const { map: nextMap, proposal } = setProposalStatus(map, "owner/repo", 1, "accepted");

    expect(map).toEqual(before); // original untouched
    expect(nextMap).not.toBe(map);
    expect(proposal).toMatchObject({ version: 1, status: "accepted" });
    expect(getProposal(nextMap, "owner/repo", 1)?.status).toBe("accepted");
  });

  it("returns a null proposal for an unknown version, without throwing", () => {
    const map: TaxonomyProposalStateMap = {};
    const result = setProposalStatus(map, "owner/repo", 99, "rejected");
    expect(result.proposal).toBeNull();
  });
});

describe("editDraftProposal", () => {
  it("updates a draft's content and keeps it draft", () => {
    let map: TaxonomyProposalStateMap = {};
    map = appendDraftProposal(map, "owner/repo", { ...CONTENT, sourceStats: STATS }).map;

    const edited = editDraftProposal(map, "owner/repo", 1, { labels: [{ name: "edited-label" }], fields: [], categories: [], rationale: "edited" });

    expect(edited.proposal).toMatchObject({ status: "draft", labels: [{ name: "edited-label" }], rationale: "edited" });
  });

  it("refuses to edit an accepted version", () => {
    let map: TaxonomyProposalStateMap = {};
    map = appendDraftProposal(map, "owner/repo", { ...CONTENT, sourceStats: STATS }).map;
    map = setProposalStatus(map, "owner/repo", 1, "accepted").map;

    const result = editDraftProposal(map, "owner/repo", 1, { labels: [], fields: [], categories: [] });
    expect(result.error).toBe("not-draft");
    expect(result.proposal).toBeNull();
  });

  it("returns not-found for an unknown version", () => {
    const map: TaxonomyProposalStateMap = {};
    const result = editDraftProposal(map, "owner/repo", 5, { labels: [], fields: [], categories: [] });
    expect(result.error).toBe("not-found");
  });
});

describe("serialize/parse round trip", () => {
  it("is stable and sorted by repo key", () => {
    let map: TaxonomyProposalStateMap = {};
    map = appendDraftProposal(map, "zzz/repo", { ...CONTENT, sourceStats: STATS }).map;
    map = appendDraftProposal(map, "aaa/repo", { ...CONTENT, sourceStats: STATS }).map;

    const serialized = serializeTaxonomyState(map);
    expect(serialized.indexOf('"aaa/repo"')).toBeLessThan(serialized.indexOf('"zzz/repo"'));

    const roundTripped = parseTaxonomyState(serialized);
    expect(roundTripped).toEqual(map);
    expect(serializeTaxonomyState(roundTripped)).toBe(serialized);
  });

  it("normalizes repo keys case-insensitively", () => {
    let map: TaxonomyProposalStateMap = {};
    map = appendDraftProposal(map, "Owner/RepoA", { ...CONTENT, sourceStats: STATS }).map;
    expect(getRepoProposals(map, "owner/repoa")).toHaveLength(1);
    expect(Object.keys(map)).toEqual(["owner/repoa"]);
  });
});
