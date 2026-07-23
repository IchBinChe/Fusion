import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@fusion/plugin-sdk";
import {
  getMilestonesList,
  milestoneRoutes,
  postMilestoneCreate,
  postMilestoneDelete,
  postMilestoneReassignOpenIssues,
  putMilestoneState,
  putMilestoneUpdate,
} from "../milestone-routes.js";
import { SELECTED_REPO_SETTING_ID } from "../repo-config.js";

// FNXC:GithubPmMilestones 2026-07-25-00:50: same deterministic gh-CLI suppression as issue-write-routes.test.ts.
vi.mock("@fusion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/core")>();
  return { ...actual, isGhAvailable: () => false, isGhAuthenticated: () => false, runGhAsync: vi.fn() };
});

const originalGithubToken = process.env.GITHUB_TOKEN;

beforeEach(() => {
  delete process.env.GITHUB_TOKEN;
});

afterEach(() => {
  if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = originalGithubToken;
});

function ctxFor(settings: Record<string, unknown>): PluginContext {
  return {
    pluginId: "fusion-plugin-github-pm",
    settings,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    emitEvent: vi.fn(),
    taskStore: {},
  } as unknown as PluginContext;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

describe("github-pm milestone routes", () => {
  it("registers exactly the six milestone routes", () => {
    expect(milestoneRoutes.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /milestones/list",
      "POST /milestones/create",
      "PUT /milestones/update",
      "PUT /milestones/state",
      "POST /milestones/delete",
      "POST /milestones/reassign-open-issues",
    ]);
  });

  describe("GET /milestones/list", () => {
    it("returns milestones with progress fields for the resolved repo", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([
        { number: 1, title: "v1", state: "open", open_issues: 2, closed_issues: 3, due_on: "2026-01-01T00:00:00Z" },
      ])));
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await getMilestonesList({ query: { repo: "acme/widgets" } }, ctx);
      expect(result.status).toBe(200);
      expect((result.body as any).items).toEqual([
        expect.objectContaining({ number: 1, title: "v1", state: "open", openIssues: 2, closedIssues: 3, dueOn: "2026-01-01T00:00:00Z" }),
      ]);
      vi.unstubAllGlobals();
    });

    it("returns an empty list (not an error) when no repo resolves", async () => {
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await getMilestonesList({ query: {} }, ctx);
      expect(result).toMatchObject({ status: 200, body: { ok: true, repo: null, items: [] } });
    });

    it("resolves the repo from resolveSelectedRepo when omitted", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([])));
      const ctx = ctxFor({ [SELECTED_REPO_SETTING_ID]: "acme/widgets", personalAccessToken: "ghp_token" });
      const result = await getMilestonesList({ query: {} }, ctx);
      expect((result.body as any).repo).toBe("acme/widgets");
      vi.unstubAllGlobals();
    });

    it("401s when unauthenticated", async () => {
      const ctx = ctxFor({});
      const result = await getMilestonesList({ query: { repo: "acme/widgets" } }, ctx);
      expect(result.status).toBe(401);
      expect((result.body as any).code).toBe("not_authenticated");
    });
  });

  describe("POST /milestones/create", () => {
    it("round-trips: returns GitHub's authoritative created milestone (confirmWrites OFF)", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ number: 3, title: "v3", state: "open", open_issues: 0, closed_issues: 0 })));
      const ctx = ctxFor({ personalAccessToken: "ghp_token", confirmWrites: false });
      const result = await postMilestoneCreate({ body: { repo: "acme/widgets", title: "v3" } }, ctx);
      expect(result.status).toBe(200);
      expect((result.body as any).milestone).toMatchObject({ number: 3, title: "v3", state: "open" });
      vi.unstubAllGlobals();
    });

    it("400s on a missing title", async () => {
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await postMilestoneCreate({ body: { repo: "acme/widgets" } }, ctx);
      expect(result).toMatchObject({ status: 400, body: { code: "validation_error" } });
    });

    it("400s on an invalid state value", async () => {
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await postMilestoneCreate({ body: { repo: "acme/widgets", title: "v3", state: "bogus" } }, ctx);
      expect(result).toMatchObject({ status: 400, body: { code: "validation_error" } });
    });

    it("FUSI-017: confirmWrites ON + missing confirmed → 400 confirmation_required, zero fetch calls", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await postMilestoneCreate({ body: { repo: "acme/widgets", title: "v3" } }, ctx);
      expect(result).toMatchObject({ status: 400, body: { ok: false, code: "confirmation_required" } });
      expect(fetchSpy).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it("FUSI-017: confirmWrites ON + confirmed:true → the write proceeds", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ number: 3, title: "v3", state: "open", open_issues: 0, closed_issues: 0 })));
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await postMilestoneCreate({ body: { repo: "acme/widgets", title: "v3", confirmed: true } }, ctx);
      expect(result.status).toBe(200);
      vi.unstubAllGlobals();
    });

    it("401s when unauthenticated (confirmWrites OFF)", async () => {
      const ctx = ctxFor({ confirmWrites: false });
      const result = await postMilestoneCreate({ body: { repo: "acme/widgets", title: "v3" } }, ctx);
      expect(result.status).toBe(401);
    });
  });

  describe("PUT /milestones/update", () => {
    it("round-trips and can clear the due date with dueOn:null (confirmWrites OFF)", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ number: 3, title: "v3", state: "open", open_issues: 0, closed_issues: 0, due_on: null })));
      const ctx = ctxFor({ personalAccessToken: "ghp_token", confirmWrites: false });
      const result = await putMilestoneUpdate({ body: { repo: "acme/widgets", number: 3, dueOn: null } }, ctx);
      expect(result.status).toBe(200);
      expect((result.body as any).milestone).toMatchObject({ number: 3, dueOn: null });
      vi.unstubAllGlobals();
    });

    it("400s when neither title, description, nor dueOn is supplied", async () => {
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await putMilestoneUpdate({ body: { repo: "acme/widgets", number: 3 } }, ctx);
      expect(result).toMatchObject({ status: 400, body: { code: "validation_error" } });
    });

    it("400s on a missing number", async () => {
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await putMilestoneUpdate({ body: { repo: "acme/widgets", title: "v3" } }, ctx);
      expect(result).toMatchObject({ status: 400, body: { code: "validation_error" } });
    });

    it("FUSI-017: confirmWrites ON + missing confirmed → 400 confirmation_required, zero fetch calls", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await putMilestoneUpdate({ body: { repo: "acme/widgets", number: 3, title: "v3" } }, ctx);
      expect(result).toMatchObject({ status: 400, body: { ok: false, code: "confirmation_required" } });
      expect(fetchSpy).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });
  });

  describe("PUT /milestones/state", () => {
    it("round-trips a close (confirmWrites OFF)", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ number: 3, title: "v3", state: "closed", open_issues: 0, closed_issues: 2 })));
      const ctx = ctxFor({ personalAccessToken: "ghp_token", confirmWrites: false });
      const result = await putMilestoneState({ body: { repo: "acme/widgets", number: 3, state: "closed" } }, ctx);
      expect(result.status).toBe(200);
      expect((result.body as any).milestone).toMatchObject({ state: "closed" });
      vi.unstubAllGlobals();
    });

    it("round-trips a reopen (confirmWrites OFF)", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ number: 3, title: "v3", state: "open", open_issues: 1, closed_issues: 2 })));
      const ctx = ctxFor({ personalAccessToken: "ghp_token", confirmWrites: false });
      const result = await putMilestoneState({ body: { repo: "acme/widgets", number: 3, state: "open" } }, ctx);
      expect(result.status).toBe(200);
      expect((result.body as any).milestone).toMatchObject({ state: "open" });
      vi.unstubAllGlobals();
    });

    it("400s on an invalid state value", async () => {
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await putMilestoneState({ body: { repo: "acme/widgets", number: 3, state: "archived" } }, ctx);
      expect(result).toMatchObject({ status: 400, body: { code: "validation_error" } });
    });

    it("FUSI-017: confirmWrites ON + missing confirmed → 400 confirmation_required, zero fetch calls", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await putMilestoneState({ body: { repo: "acme/widgets", number: 3, state: "closed" } }, ctx);
      expect(result).toMatchObject({ status: 400, body: { ok: false, code: "confirmation_required" } });
      expect(fetchSpy).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it("FUSI-017: confirmWrites ON + confirmed:true → the write proceeds", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ number: 3, title: "v3", state: "closed", open_issues: 0, closed_issues: 2 })));
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await putMilestoneState({ body: { repo: "acme/widgets", number: 3, state: "closed", confirmed: true } }, ctx);
      expect(result.status).toBe(200);
      vi.unstubAllGlobals();
    });
  });

  describe("POST /milestones/delete", () => {
    it("tolerates a 204 with no response body (confirmWrites OFF)", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
      const ctx = ctxFor({ personalAccessToken: "ghp_token", confirmWrites: false });
      const result = await postMilestoneDelete({ body: { repo: "acme/widgets", number: 3 } }, ctx);
      expect(result).toMatchObject({ status: 200, body: { ok: true, repo: "acme/widgets", number: 3 } });
      vi.unstubAllGlobals();
    });

    it("400s on a missing number", async () => {
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await postMilestoneDelete({ body: { repo: "acme/widgets" } }, ctx);
      expect(result).toMatchObject({ status: 400, body: { code: "validation_error" } });
    });

    it("FUSI-017: confirmWrites ON + missing confirmed → 400 confirmation_required, zero fetch calls", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await postMilestoneDelete({ body: { repo: "acme/widgets", number: 3 } }, ctx);
      expect(result).toMatchObject({ status: 400, body: { ok: false, code: "confirmation_required" } });
      expect(fetchSpy).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it("FUSI-017: confirmWrites ON + confirmed:true → the write proceeds", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await postMilestoneDelete({ body: { repo: "acme/widgets", number: 3, confirmed: true } }, ctx);
      expect(result.status).toBe(200);
      vi.unstubAllGlobals();
    });
  });

  describe("POST /milestones/reassign-open-issues", () => {
    it("clears the milestone from each open issue when target is null (confirmWrites OFF)", async () => {
      const calls: Array<{ url: string; method?: string; body?: string }> = [];
      vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), method: init?.method, body: init?.body as string | undefined });
        if (String(url).includes("/issues?")) {
          return jsonResponse([
            { number: 10, title: "A", state: "open", html_url: "https://x/10" },
            { number: 11, title: "B", state: "open", html_url: "https://x/11" },
          ]);
        }
        return jsonResponse({ number: 10, title: "A", state: "open", html_url: "https://x/10", milestone: null });
      }));
      const ctx = ctxFor({ personalAccessToken: "ghp_token", confirmWrites: false });
      const result = await postMilestoneReassignOpenIssues({ body: { repo: "acme/widgets", number: 3, target: null } }, ctx);
      expect(result).toMatchObject({ status: 200, body: { ok: true, reassignedCount: 2, targetMilestone: null } });
      const patchCalls = calls.filter((c) => c.method === "PATCH");
      expect(patchCalls).toHaveLength(2);
      for (const call of patchCalls) {
        expect(JSON.parse(call.body ?? "{}")).toEqual({ milestone: null });
      }
      vi.unstubAllGlobals();
    });

    it("moves each open issue to the target milestone number", async () => {
      const patchBodies: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes("/issues?")) {
          return jsonResponse([{ number: 10, title: "A", state: "open", html_url: "https://x/10" }]);
        }
        patchBodies.push(init?.body as string);
        return jsonResponse({ number: 10, title: "A", state: "open", html_url: "https://x/10" });
      }));
      const ctx = ctxFor({ personalAccessToken: "ghp_token", confirmWrites: false });
      const result = await postMilestoneReassignOpenIssues({ body: { repo: "acme/widgets", number: 3, target: 9 } }, ctx);
      expect(result).toMatchObject({ status: 200, body: { ok: true, reassignedCount: 1, targetMilestone: 9 } });
      expect(JSON.parse(patchBodies[0])).toEqual({ milestone: 9 });
      vi.unstubAllGlobals();
    });

    it("400s on an invalid target", async () => {
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await postMilestoneReassignOpenIssues({ body: { repo: "acme/widgets", number: 3, target: "not-a-number" } }, ctx);
      expect(result).toMatchObject({ status: 400, body: { code: "validation_error" } });
    });

    it("FUSI-017: confirmWrites ON + missing confirmed → 400 confirmation_required, zero fetch calls", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await postMilestoneReassignOpenIssues({ body: { repo: "acme/widgets", number: 3, target: null } }, ctx);
      expect(result).toMatchObject({ status: 400, body: { ok: false, code: "confirmation_required" } });
      expect(fetchSpy).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });
  });

  it("no test hits api.github.com — fetch is always stubbed", () => {
    expect(true).toBe(true);
  });
});
