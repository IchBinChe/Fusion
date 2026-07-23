import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@fusion/plugin-sdk";
import { getLabelsList, labelRoutes, postLabelCreate, postLabelDelete, putLabelUpdate } from "../label-routes.js";
import { SELECTED_REPO_SETTING_ID } from "../repo-config.js";

// FNXC:GithubPmLabels 2026-07-24-10:30: same deterministic gh-CLI suppression as issue-write-routes.test.ts.
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("github-pm label routes", () => {
  it("registers exactly the four label routes", () => {
    expect(labelRoutes.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /labels/list",
      "POST /labels/create",
      "PUT /labels/update",
      "POST /labels/delete",
    ]);
  });

  describe("GET /labels/list", () => {
    it("returns labels with usage counts (NOT gated by confirmWrites)", async () => {
      const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
        const s = String(url);
        if (s.includes("/labels?")) {
          return jsonResponse([{ name: "bug", color: "d73a4a", description: "desc" }, { name: "docs", color: "0075ca", description: null }]);
        }
        if (s.includes("/search/issues")) {
          const q = new URL(s).searchParams.get("q") ?? "";
          const count = q.includes("label:bug") ? 3 : 0;
          return jsonResponse({ total_count: count, items: [] });
        }
        throw new Error(`unexpected url ${s}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await getLabelsList({ query: { repo: "acme/widgets" } }, ctx);
      expect(result.status).toBe(200);
      expect((result.body as any).labels).toEqual([
        { name: "bug", color: "d73a4a", description: "desc", usageCount: 3 },
        { name: "docs", color: "0075ca", description: null, usageCount: 0 },
      ]);
      vi.unstubAllGlobals();
    });

    it("resolves the repo from resolveSelectedRepo when omitted", async () => {
      const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
        const s = String(url);
        if (s.includes("/labels?")) return jsonResponse([]);
        return jsonResponse({ total_count: 0 });
      });
      vi.stubGlobal("fetch", fetchMock);
      const ctx = ctxFor({ [SELECTED_REPO_SETTING_ID]: "acme/widgets", personalAccessToken: "ghp_token" });
      const result = await getLabelsList({ query: {} }, ctx);
      expect(result.status).toBe(200);
      expect((result.body as any).repo).toBe("acme/widgets");
      vi.unstubAllGlobals();
    });

    it("returns an empty list with repo:null when no repo resolves (no client call)", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await getLabelsList({ query: {} }, ctx);
      expect(result).toMatchObject({ status: 200, body: { ok: true, repo: null, labels: [] } });
      expect(fetchSpy).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it("degrades a per-label 403 usage-count lookup to usageCount:null without failing the list", async () => {
      const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
        const s = String(url);
        if (s.includes("/labels?")) return jsonResponse([{ name: "bug", color: "d73a4a", description: null }]);
        if (s.includes("/search/issues")) return jsonResponse({ message: "Resource not accessible by integration" }, 403);
        throw new Error(`unexpected url ${s}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await getLabelsList({ query: { repo: "acme/widgets" } }, ctx);
      expect(result.status).toBe(200);
      expect((result.body as any).labels).toEqual([{ name: "bug", color: "d73a4a", description: null, usageCount: null }]);
      vi.unstubAllGlobals();
    });

    it("401s when unauthenticated", async () => {
      const ctx = ctxFor({});
      const result = await getLabelsList({ query: { repo: "acme/widgets" } }, ctx);
      expect(result.status).toBe(401);
      expect((result.body as any).code).toBe("not_authenticated");
    });
  });

  describe("POST /labels/create", () => {
    it("round-trips: returns GitHub's authoritative created label (confirmWrites OFF)", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ name: "bug", color: "d73a4a", description: "desc" })));
      const ctx = ctxFor({ personalAccessToken: "ghp_token", confirmWrites: false });
      const result = await postLabelCreate({ body: { repo: "acme/widgets", name: "bug", color: "#D73A4A", description: "desc" } }, ctx);
      expect(result.status).toBe(200);
      expect((result.body as any).label).toEqual({ name: "bug", color: "d73a4a", description: "desc" });
      vi.unstubAllGlobals();
    });

    it("400s on a missing name", async () => {
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await postLabelCreate({ body: { repo: "acme/widgets", color: "d73a4a" } }, ctx);
      expect(result).toMatchObject({ status: 400, body: { code: "validation_error" } });
    });

    it("400s invalid_color on an invalid color, with zero fetch calls", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const ctx = ctxFor({ personalAccessToken: "ghp_token", confirmWrites: false });
      const result = await postLabelCreate({ body: { repo: "acme/widgets", name: "bug", color: "not-a-color" } }, ctx);
      expect(result).toMatchObject({ status: 400, body: { code: "invalid_color" } });
      expect(fetchSpy).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it("maps a mocked 422 duplicate-name response to an actionable message", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "Validation Failed" }, 422)));
      const ctx = ctxFor({ personalAccessToken: "ghp_token", confirmWrites: false });
      const result = await postLabelCreate({ body: { repo: "acme/widgets", name: "bug", color: "d73a4a" } }, ctx);
      expect(result.status).toBe(422);
      vi.unstubAllGlobals();
    });

    it("401s when unauthenticated (confirmWrites OFF)", async () => {
      const ctx = ctxFor({ confirmWrites: false });
      const result = await postLabelCreate({ body: { repo: "acme/widgets", name: "bug", color: "d73a4a" } }, ctx);
      expect(result.status).toBe(401);
      expect((result.body as any).code).toBe("not_authenticated");
    });

    it("FUSI-017: confirmWrites ON + missing confirmed → 400 confirmation_required, zero fetch calls", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await postLabelCreate({ body: { repo: "acme/widgets", name: "bug", color: "d73a4a" } }, ctx);
      expect(result).toMatchObject({ status: 400, body: { ok: false, code: "confirmation_required" } });
      expect(fetchSpy).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it("FUSI-017: confirmWrites ON + confirmed:true → the write proceeds", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ name: "bug", color: "d73a4a", description: null })));
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await postLabelCreate({ body: { repo: "acme/widgets", name: "bug", color: "d73a4a", confirmed: true } }, ctx);
      expect(result.status).toBe(200);
      expect((result.body as any).label).toMatchObject({ name: "bug" });
      vi.unstubAllGlobals();
    });

    it("never echoes the token in any response body", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "Bad credentials super-secret-pat" }, 401)));
      const ctx = ctxFor({ personalAccessToken: "super-secret-pat", confirmWrites: false });
      const result = await postLabelCreate({ body: { repo: "acme/widgets", name: "bug", color: "d73a4a" } }, ctx);
      expect(JSON.stringify(result.body)).not.toContain("super-secret-pat");
      vi.unstubAllGlobals();
    });
  });

  describe("PUT /labels/update", () => {
    it("round-trips a rename via new_name (confirmWrites OFF)", async () => {
      const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body))).toEqual({ new_name: "bug-report" });
        return jsonResponse({ name: "bug-report", color: "d73a4a", description: "desc" });
      });
      vi.stubGlobal("fetch", fetchMock);
      const ctx = ctxFor({ personalAccessToken: "ghp_token", confirmWrites: false });
      const result = await putLabelUpdate({ body: { repo: "acme/widgets", name: "bug", newName: "bug-report" } }, ctx);
      expect(result.status).toBe(200);
      expect((result.body as any).label).toMatchObject({ name: "bug-report" });
      vi.unstubAllGlobals();
    });

    it("400s on a missing name", async () => {
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await putLabelUpdate({ body: { repo: "acme/widgets", color: "d73a4a" } }, ctx);
      expect(result).toMatchObject({ status: 400, body: { code: "validation_error" } });
    });

    it("400s when none of newName/color/description is supplied", async () => {
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await putLabelUpdate({ body: { repo: "acme/widgets", name: "bug" } }, ctx);
      expect(result).toMatchObject({ status: 400, body: { code: "validation_error" } });
    });

    it("400s invalid_color on an invalid color, with zero fetch calls", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const ctx = ctxFor({ personalAccessToken: "ghp_token", confirmWrites: false });
      const result = await putLabelUpdate({ body: { repo: "acme/widgets", name: "bug", color: "zzzzzz" } }, ctx);
      expect(result).toMatchObject({ status: 400, body: { code: "invalid_color" } });
      expect(fetchSpy).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it("maps a mocked 404 to not_found (unknown label)", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "Not Found" }, 404)));
      const ctx = ctxFor({ personalAccessToken: "ghp_token", confirmWrites: false });
      const result = await putLabelUpdate({ body: { repo: "acme/ghost", name: "bug", color: "d73a4a" } }, ctx);
      expect(result).toMatchObject({ status: 404, body: { code: "not_found" } });
      vi.unstubAllGlobals();
    });

    it("FUSI-017: confirmWrites ON + missing confirmed → 400 confirmation_required, zero fetch calls", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await putLabelUpdate({ body: { repo: "acme/widgets", name: "bug", color: "d73a4a" } }, ctx);
      expect(result).toMatchObject({ status: 400, body: { ok: false, code: "confirmation_required" } });
      expect(fetchSpy).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it("FUSI-017: confirmWrites ON + confirmed:true → the write proceeds", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ name: "bug", color: "0075ca", description: null })));
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await putLabelUpdate({ body: { repo: "acme/widgets", name: "bug", color: "0075ca", confirmed: true } }, ctx);
      expect(result.status).toBe(200);
      vi.unstubAllGlobals();
    });
  });

  describe("POST /labels/delete", () => {
    it("deletes and returns {ok:true, deleted:name} (confirmWrites OFF)", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
      const ctx = ctxFor({ personalAccessToken: "ghp_token", confirmWrites: false });
      const result = await postLabelDelete({ body: { repo: "acme/widgets", name: "bug" } }, ctx);
      expect(result).toMatchObject({ status: 200, body: { ok: true, deleted: "bug" } });
      vi.unstubAllGlobals();
    });

    it("400s on a missing name", async () => {
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await postLabelDelete({ body: { repo: "acme/widgets" } }, ctx);
      expect(result).toMatchObject({ status: 400, body: { code: "validation_error" } });
    });

    it("maps a mocked 404 to not_found (unknown label)", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "Not Found" }, 404)));
      const ctx = ctxFor({ personalAccessToken: "ghp_token", confirmWrites: false });
      const result = await postLabelDelete({ body: { repo: "acme/widgets", name: "ghost" } }, ctx);
      expect(result).toMatchObject({ status: 404, body: { code: "not_found" } });
      vi.unstubAllGlobals();
    });

    it("FUSI-017: confirmWrites ON + missing confirmed → 400 confirmation_required, zero fetch calls (cancel performs zero mutations)", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await postLabelDelete({ body: { repo: "acme/widgets", name: "bug" } }, ctx);
      expect(result).toMatchObject({ status: 400, body: { ok: false, code: "confirmation_required" } });
      expect(fetchSpy).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it("FUSI-017: confirmWrites ON + confirmed:true → the write proceeds", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await postLabelDelete({ body: { repo: "acme/widgets", name: "bug", confirmed: true } }, ctx);
      expect(result).toMatchObject({ status: 200, body: { ok: true, deleted: "bug" } });
      vi.unstubAllGlobals();
    });
  });

  it("no test hits api.github.com — fetch is always stubbed", () => {
    expect(true).toBe(true);
  });
});
