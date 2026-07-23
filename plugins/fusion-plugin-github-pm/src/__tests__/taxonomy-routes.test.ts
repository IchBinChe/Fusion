import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@fusion/plugin-sdk";
import {
  getTaxonomyProposals,
  postTaxonomyPropose,
  putTaxonomyAccept,
  putTaxonomyEdit,
  putTaxonomyReject,
  taxonomyRoutes,
} from "../taxonomy-routes.js";
import { REPO_CONFIG_STATE_SETTING_ID } from "../repo-config.js";
import { TAXONOMY_PROPOSAL_STATE_SETTING_ID } from "../taxonomy-store.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Serves REST issues + GraphQL labels/discussions from injected fixtures, keyed off the URL/query shape. */
function stubGitHubFetch() {
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    if (typeof url === "string" && url.includes("/issues")) {
      return jsonResponse([{ number: 1, title: "Distinctive-Fixture-Term bug", state: "open", html_url: "u1", labels: [{ name: "bug" }] }]);
    }
    if (typeof url === "string" && url.includes("/graphql")) {
      const body = JSON.parse(String(init?.body));
      if (String(body.query).includes("discussions(")) {
        return jsonResponse({ data: { repository: { discussions: { nodes: [{ number: 5, title: "Q about X", category: { name: "Q&A" } }], pageInfo: { hasNextPage: false, endCursor: null } } } } });
      }
      return jsonResponse({ data: { repository: { labels: { nodes: [{ id: "L1", name: "bug", color: "red" }], pageInfo: { hasNextPage: false, endCursor: null } } } } });
    }
    return jsonResponse({}, 404);
  });
  vi.stubGlobal("fetch", fetchImpl);
  return fetchImpl;
}

function fakeCreateAiSession(assistantText: string) {
  return vi.fn(async () => ({
    session: {
      prompt: vi.fn(async () => undefined),
      state: { messages: [{ role: "assistant", content: assistantText }] },
    },
  }));
}

const PROPOSAL_JSON = "```json\n" + JSON.stringify({
  labels: [{ name: "distinctive-fixture-label" }],
  fields: [{ name: "Priority", type: "single-select", options: ["low", "high"] }],
  categories: [{ name: "Q&A" }],
  rationale: "grounded in observed data",
}) + "\n```";

/** A fake PluginStore whose updatePluginSettings mutates a shared in-memory settings object. */
function makePersistedSettings(initial: Record<string, unknown> = {}) {
  const settings: Record<string, unknown> = { ...initial };
  const updatePluginSettings = vi.fn(async (_pluginId: string, patch: Record<string, unknown>) => {
    Object.assign(settings, patch);
    return settings;
  });
  return { settings, updatePluginSettings };
}

function ctxFor(
  settings: Record<string, unknown>,
  options: { updatePluginSettings?: ReturnType<typeof vi.fn>; createAiSession?: ReturnType<typeof fakeCreateAiSession> | undefined; missingStore?: boolean } = {},
): PluginContext {
  return {
    pluginId: "fusion-plugin-github-pm",
    settings,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    emitEvent: vi.fn(),
    taskStore: options.missingStore
      ? { getRootDir: () => "/tmp/repo" }
      : { getRootDir: () => "/tmp/repo", getPluginStore: () => ({ updatePluginSettings: options.updatePluginSettings ?? vi.fn() }) },
    createAiSession: options.createAiSession,
  } as unknown as PluginContext;
}

describe("github-pm taxonomy routes", () => {
  beforeEach(() => {
    stubGitHubFetch();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers exactly the five taxonomy routes", () => {
    expect(taxonomyRoutes.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /taxonomy/propose",
      "GET /taxonomy/proposals",
      "PUT /taxonomy/proposals/accept",
      "PUT /taxonomy/proposals/reject",
      "PUT /taxonomy/proposals/edit",
    ]);
  });

  it("propose does NOT auto-apply -- approvedTaxonomyVersion is unchanged and a draft exists", async () => {
    const persisted = makePersistedSettings();
    const createAiSession = fakeCreateAiSession(PROPOSAL_JSON);
    const ctx = ctxFor(persisted.settings, { updatePluginSettings: persisted.updatePluginSettings, createAiSession });

    const result = await postTaxonomyPropose({ body: { repo: "owner/repo" } }, ctx);

    expect(result.status).toBe(200);
    expect((result.body as any).proposal).toMatchObject({ version: 1, status: "draft" });

    const readCtx = ctxFor(persisted.settings);
    const read = await getTaxonomyProposals({ query: { repo: "owner/repo" } }, readCtx);
    expect((read.body as any).approvedTaxonomyVersion).toBeNull();
    expect((read.body as any).proposals).toHaveLength(1);
  });

  it("accept is the only apply -- sets approvedTaxonomyVersion and marks the proposal accepted", async () => {
    const persisted = makePersistedSettings();
    const createAiSession = fakeCreateAiSession(PROPOSAL_JSON);
    await postTaxonomyPropose({ body: { repo: "owner/repo" } }, ctxFor(persisted.settings, { updatePluginSettings: persisted.updatePluginSettings, createAiSession }));

    const acceptResult = await putTaxonomyAccept({ body: { repo: "owner/repo", version: 1 } }, ctxFor(persisted.settings, { updatePluginSettings: persisted.updatePluginSettings }));

    expect(acceptResult).toMatchObject({ status: 200, body: { ok: true, approvedTaxonomyVersion: 1, proposal: { status: "accepted" } } });

    const read = await getTaxonomyProposals({ query: { repo: "owner/repo" } }, ctxFor(persisted.settings));
    expect((read.body as any).approvedTaxonomyVersion).toBe(1);
  });

  it("reject leaves approvedTaxonomyVersion untouched", async () => {
    const persisted = makePersistedSettings();
    const createAiSession = fakeCreateAiSession(PROPOSAL_JSON);
    await postTaxonomyPropose({ body: { repo: "owner/repo" } }, ctxFor(persisted.settings, { updatePluginSettings: persisted.updatePluginSettings, createAiSession }));

    const rejectResult = await putTaxonomyReject({ body: { repo: "owner/repo", version: 1 } }, ctxFor(persisted.settings, { updatePluginSettings: persisted.updatePluginSettings }));

    expect(rejectResult).toMatchObject({ status: 200, body: { ok: true, proposal: { status: "rejected" } } });
    const read = await getTaxonomyProposals({ query: { repo: "owner/repo" } }, ctxFor(persisted.settings));
    expect((read.body as any).approvedTaxonomyVersion).toBeNull();
  });

  it("edit leaves approvedTaxonomyVersion untouched and keeps the proposal a draft", async () => {
    const persisted = makePersistedSettings();
    const createAiSession = fakeCreateAiSession(PROPOSAL_JSON);
    await postTaxonomyPropose({ body: { repo: "owner/repo" } }, ctxFor(persisted.settings, { updatePluginSettings: persisted.updatePluginSettings, createAiSession }));

    const editResult = await putTaxonomyEdit(
      { body: { repo: "owner/repo", version: 1, proposal: { labels: [{ name: "edited" }], fields: [], categories: [], rationale: "manual edit" } } },
      ctxFor(persisted.settings, { updatePluginSettings: persisted.updatePluginSettings }),
    );

    expect(editResult).toMatchObject({ status: 200, body: { ok: true, proposal: { status: "draft", labels: [{ name: "edited" }] } } });
    const read = await getTaxonomyProposals({ query: { repo: "owner/repo" } }, ctxFor(persisted.settings));
    expect((read.body as any).approvedTaxonomyVersion).toBeNull();
  });

  it("refuses to edit an accepted version (409)", async () => {
    const persisted = makePersistedSettings();
    const createAiSession = fakeCreateAiSession(PROPOSAL_JSON);
    await postTaxonomyPropose({ body: { repo: "owner/repo" } }, ctxFor(persisted.settings, { updatePluginSettings: persisted.updatePluginSettings, createAiSession }));
    await putTaxonomyAccept({ body: { repo: "owner/repo", version: 1 } }, ctxFor(persisted.settings, { updatePluginSettings: persisted.updatePluginSettings }));

    const editResult = await putTaxonomyEdit(
      { body: { repo: "owner/repo", version: 1, proposal: { labels: [], fields: [], categories: [] } } },
      ctxFor(persisted.settings, { updatePluginSettings: persisted.updatePluginSettings }),
    );
    expect(editResult).toMatchObject({ status: 409, body: { code: "not_draft" } });
  });

  it("restart survival: a FRESH ctx seeded only from the persisted settings blob still returns the accepted version", async () => {
    const persisted = makePersistedSettings();
    const createAiSession = fakeCreateAiSession(PROPOSAL_JSON);
    await postTaxonomyPropose({ body: { repo: "owner/repo" } }, ctxFor(persisted.settings, { updatePluginSettings: persisted.updatePluginSettings, createAiSession }));
    await putTaxonomyAccept({ body: { repo: "owner/repo", version: 1 } }, ctxFor(persisted.settings, { updatePluginSettings: persisted.updatePluginSettings }));

    const capturedBlob = JSON.parse(JSON.stringify(persisted.settings));
    const freshSettings: Record<string, unknown> = { ...capturedBlob };
    const freshCtx = ctxFor(freshSettings);

    const read = await getTaxonomyProposals({ query: { repo: "owner/repo" } }, freshCtx);
    expect(read).toMatchObject({ status: 200, body: { ok: true, approvedTaxonomyVersion: 1 } });
    expect((read.body as any).proposals[0]).toMatchObject({ version: 1, status: "accepted" });
    expect(typeof freshSettings[TAXONOMY_PROPOSAL_STATE_SETTING_ID]).toBe("string");
    expect(typeof freshSettings[REPO_CONFIG_STATE_SETTING_ID]).toBe("string");
  });

  it("validation: invalid repo returns 400", async () => {
    const persisted = makePersistedSettings();
    const result = await postTaxonomyPropose({ body: { repo: "not-valid" } }, ctxFor(persisted.settings, { updatePluginSettings: persisted.updatePluginSettings }));
    expect(result).toMatchObject({ status: 400, body: { code: "validation_error" } });
  });

  it("validation: missing getPluginStore returns a stable 500", async () => {
    const ctx = ctxFor({}, { missingStore: true });
    const result = await postTaxonomyPropose({ body: { repo: "owner/repo" } }, ctx);
    expect(result).toMatchObject({ status: 500, body: { code: "plugin_store_unavailable" } });
  });

  it("no-secret invariant: persisted writes never include PAT/password fields", async () => {
    const persisted = makePersistedSettings({ personalAccessToken: "ghp_super_secret" });
    const createAiSession = fakeCreateAiSession(PROPOSAL_JSON);
    await postTaxonomyPropose({ body: { repo: "owner/repo" } }, ctxFor(persisted.settings, { updatePluginSettings: persisted.updatePluginSettings, createAiSession }));
    await putTaxonomyAccept({ body: { repo: "owner/repo", version: 1 } }, ctxFor(persisted.settings, { updatePluginSettings: persisted.updatePluginSettings }));

    for (const call of persisted.updatePluginSettings.mock.calls) {
      const patch = call[1] as Record<string, unknown>;
      expect(patch).not.toHaveProperty("personalAccessToken");
      expect(JSON.stringify(patch)).not.toContain("ghp_super_secret");
    }
  });

  it("testMode/mock: the only AI path is the injected createAiSession, called with tools: readonly; no real model call", async () => {
    const persisted = makePersistedSettings();
    const createAiSession = fakeCreateAiSession(PROPOSAL_JSON);
    await postTaxonomyPropose({ body: { repo: "owner/repo" } }, ctxFor(persisted.settings, { updatePluginSettings: persisted.updatePluginSettings, createAiSession }));

    expect(createAiSession).toHaveBeenCalledTimes(1);
    expect(createAiSession).toHaveBeenCalledWith(expect.objectContaining({ tools: "readonly" }));
  });

  it("returns a typed 502 when ctx.createAiSession is undefined (engine not loaded)", async () => {
    const persisted = makePersistedSettings();
    const result = await postTaxonomyPropose({ body: { repo: "owner/repo" } }, ctxFor(persisted.settings, { updatePluginSettings: persisted.updatePluginSettings, createAiSession: undefined }));
    expect(result).toMatchObject({ status: 502, body: { code: "ai-unavailable" } });
  });

  it("propose falls back to the selected repo when no repo body param is given", async () => {
    const persisted = makePersistedSettings({ selectedRepo: "owner/repo" });
    const createAiSession = fakeCreateAiSession(PROPOSAL_JSON);
    const result = await postTaxonomyPropose({ body: {} }, ctxFor(persisted.settings, { updatePluginSettings: persisted.updatePluginSettings, createAiSession }));
    expect(result).toMatchObject({ status: 200, body: { ok: true, repo: "owner/repo" } });
  });
});
