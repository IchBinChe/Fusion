import { describe, expect, it, vi } from "vitest";
import {
  aggregateRepoSignal,
  buildProposalUserPrompt,
  generateTaxonomyProposal,
  parseProposalResponse,
  type CreateAiSessionFactoryLike,
} from "../taxonomy-proposal.js";
import type { GitHubDiscussionListItem, GitHubIssueListItem, GitHubLabel } from "../github-client.js";

const FIXTURE_ISSUES: GitHubIssueListItem[] = [
  { number: 1, title: "Distinctive-Fixture-Term crashes on startup", state: "open", htmlUrl: "u1", labels: ["bug", "distinctive-fixture-label"] },
  { number: 2, title: "Add dark mode toggle", state: "open", htmlUrl: "u2", labels: ["enhancement"] },
  { number: 3, title: "Docs typo in README", state: "closed", htmlUrl: "u3", labels: ["docs"] },
];

const FIXTURE_DISCUSSIONS: GitHubDiscussionListItem[] = [
  { number: 10, title: "How does Distinctive-Fixture-Term work?", category: "Q&A" },
  { number: 11, title: "Proposal: new API", category: "Ideas" },
];

const FIXTURE_LABELS: GitHubLabel[] = [
  { id: "L1", name: "bug", color: "red" },
  { id: "L2", name: "enhancement", color: "green" },
  { id: "L3", name: "docs", color: "blue" },
  { id: "L4", name: "distinctive-fixture-label", color: "purple" },
];

describe("aggregateRepoSignal", () => {
  it("reflects the repo's actual labels/issues/discussions -- data-driven, not hardcoded", () => {
    const signal = aggregateRepoSignal({ issues: FIXTURE_ISSUES, discussions: FIXTURE_DISCUSSIONS, labels: FIXTURE_LABELS });

    expect(signal.existingLabels.map((label) => label.name)).toEqual(expect.arrayContaining(["bug", "enhancement", "docs", "distinctive-fixture-label"]));
    expect(signal.sampleIssueTitles).toContain("Distinctive-Fixture-Term crashes on startup");
    expect(signal.discussionCategories.map((category) => category.name)).toEqual(expect.arrayContaining(["Q&A", "Ideas"]));
    expect(signal.sourceStats).toEqual({ issueCount: 3, discussionCount: 2, existingLabelCount: 4 });
  });

  it("never throws on empty history and returns coherent zeroed output", () => {
    const signal = aggregateRepoSignal({ issues: [], discussions: [], labels: [] });
    expect(signal).toEqual({
      existingLabels: [],
      sampleIssueTitles: [],
      discussionCategories: [],
      sourceStats: { issueCount: 0, discussionCount: 0, existingLabelCount: 0 },
    });
  });

  it("buckets missing discussion categories under Uncategorized rather than dropping them", () => {
    const signal = aggregateRepoSignal({
      issues: [],
      discussions: [{ number: 1, title: "no category", category: null }],
      labels: [],
    });
    expect(signal.discussionCategories).toEqual([{ name: "Uncategorized", count: 1, sampleTitles: ["no category"] }]);
  });
});

describe("buildProposalUserPrompt", () => {
  it("proves the prompt is grounded in the ACTUAL repo signal by including a distinctive fixture term", () => {
    const signal = aggregateRepoSignal({ issues: FIXTURE_ISSUES, discussions: FIXTURE_DISCUSSIONS, labels: FIXTURE_LABELS });
    const prompt = buildProposalUserPrompt(signal);
    expect(prompt).toContain("distinctive-fixture-label");
    expect(prompt).toContain("Distinctive-Fixture-Term");
    expect(prompt).toContain("Q&A");
  });
});

describe("parseProposalResponse", () => {
  it("extracts a fenced JSON object and coerces fields", () => {
    const text = [
      "Here is my proposal:",
      "```json",
      JSON.stringify({
        labels: [{ name: "bug", description: "Something broken", color: "ff0000" }, { name: 123 }],
        fields: [{ name: "Priority", type: "single-select", options: ["low", "high"] }, { name: "bad", type: "not-a-type" }],
        categories: [{ name: "Bugs", exampleIssueNumbers: [1, 2] }],
        rationale: "Derived from observed labels.",
      }),
      "```",
    ].join("\n");

    const result = parseProposalResponse(text);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.content.labels).toEqual([{ name: "bug", description: "Something broken", color: "ff0000" }]);
    expect(result.content.fields).toEqual([{ name: "Priority", type: "single-select", options: ["low", "high"], description: undefined }]);
    expect(result.content.categories).toEqual([{ name: "Bugs", description: undefined, exampleIssueNumbers: [1, 2] }]);
    expect(result.content.rationale).toBe("Derived from observed labels.");
  });

  it("degrades safely on garbage input instead of throwing", () => {
    expect(parseProposalResponse("not json at all")).toEqual({ ok: false, reason: "No JSON object found in the assistant response." });
    expect(parseProposalResponse("```json\n{ this is not valid json \n```")).toMatchObject({ ok: false });
    expect(parseProposalResponse("")).toEqual({ ok: false, reason: "Assistant response was empty." });
    expect(parseProposalResponse("```json\n[1,2,3]\n```")).toMatchObject({ ok: false });
  });

  it("parses an unfenced balanced object too", () => {
    const result = parseProposalResponse(`prefix text {"labels":[],"fields":[],"categories":[]} suffix`);
    expect(result).toMatchObject({ ok: true, content: { labels: [], fields: [], categories: [] } });
  });
});

function fakeClient(overrides: Partial<{ issues: GitHubIssueListItem[]; discussions: GitHubDiscussionListItem[]; labels: GitHubLabel[] }> = {}) {
  return {
    listIssues: vi.fn(async () => overrides.issues ?? FIXTURE_ISSUES),
    listDiscussions: vi.fn(async () => overrides.discussions ?? FIXTURE_DISCUSSIONS),
    listLabels: vi.fn(async () => overrides.labels ?? FIXTURE_LABELS),
  };
}

function fakeCreateAiSession(assistantText: string): CreateAiSessionFactoryLike {
  return vi.fn(async () => ({
    session: {
      prompt: vi.fn(async () => undefined),
      state: { messages: [{ role: "assistant", content: assistantText }] },
    },
  }));
}

describe("generateTaxonomyProposal", () => {
  it("returns a proposal derived from the fixture and makes NO real network/model call (fully injected)", async () => {
    const assistantText = "```json\n" + JSON.stringify({
      labels: [{ name: "distinctive-fixture-label" }],
      fields: [],
      categories: [{ name: "Q&A" }],
      rationale: "grounded",
    }) + "\n```";
    const createAiSession = fakeCreateAiSession(assistantText);
    const client = fakeClient();

    const result = await generateTaxonomyProposal({ client, owner: "acme", repo: "widgets", createAiSession, cwd: "/tmp/repo" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.content.labels).toEqual([{ name: "distinctive-fixture-label", description: undefined, color: undefined }]);
    expect(result.sourceStats).toEqual({ issueCount: 3, discussionCount: 2, existingLabelCount: 4 });
    expect(client.listIssues).toHaveBeenCalledWith("acme", "widgets", { state: "all", maxItems: 200 });
    expect(createAiSession).toHaveBeenCalledWith(expect.objectContaining({ tools: "readonly", cwd: "/tmp/repo" }));
  });

  it("returns a typed ai-unavailable result when createAiSession is undefined, without throwing", async () => {
    const client = fakeClient();
    const result = await generateTaxonomyProposal({ client, owner: "acme", repo: "widgets", createAiSession: undefined, cwd: "/tmp" });
    expect(result).toEqual({ ok: false, reason: "ai-unavailable", message: expect.any(String) });
    expect(client.listIssues).not.toHaveBeenCalled();
  });

  it("returns a typed parse-error result when the assistant response is unparseable", async () => {
    const createAiSession = fakeCreateAiSession("no JSON here at all");
    const client = fakeClient();
    const result = await generateTaxonomyProposal({ client, owner: "acme", repo: "widgets", createAiSession, cwd: "/tmp" });
    expect(result).toMatchObject({ ok: false, reason: "parse-error" });
  });

  it("returns a coherent minimal draft (never throws) for a repo with empty history", async () => {
    const createAiSession = fakeCreateAiSession("```json\n" + JSON.stringify({ labels: [], fields: [], categories: [], rationale: "no data" }) + "\n```");
    const client = fakeClient({ issues: [], discussions: [], labels: [] });
    const result = await generateTaxonomyProposal({ client, owner: "acme", repo: "empty", createAiSession, cwd: "/tmp" });
    expect(result).toMatchObject({ ok: true, sourceStats: { issueCount: 0, discussionCount: 0, existingLabelCount: 0 } });
  });
});
