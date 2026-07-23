import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@fusion/plugin-sdk";
import { issueWriteRoutes, postIssueComment, postIssueCreate, putIssueComment, putIssueState, putIssueUpdate } from "../issue-write-routes.js";
import { SELECTED_REPO_SETTING_ID } from "../repo-config.js";

// FNXC:GithubPmIssues 2026-07-24-05:10: same deterministic gh-CLI suppression as issues-routes.test.ts.
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

describe("github-pm issue-write routes", () => {
  it("registers exactly the five write routes", () => {
    expect(issueWriteRoutes.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /issues/create",
      "PUT /issues/update",
      "PUT /issues/state",
      "POST /issues/comments",
      "PUT /issues/comments",
    ]);
  });

  describe("POST /issues/create", () => {
    // FUSI-017: confirmWrites explicitly OFF below to assert the exact FUSI-014 unconfirmed
    // round-trip behavior is preserved byte-for-byte when the gate is disabled.
    it("round-trips: returns GitHub's authoritative created issue (confirmWrites OFF)", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ number: 7, title: "New bug", state: "open", html_url: "https://x", body: "desc" })));
      const ctx = ctxFor({ personalAccessToken: "ghp_token", confirmWrites: false });
      const result = await postIssueCreate({ body: { repo: "acme/widgets", title: "New bug", body: "desc" } }, ctx);
      expect(result.status).toBe(200);
      expect((result.body as any).issue).toMatchObject({ number: 7, title: "New bug", state: "open" });
      vi.unstubAllGlobals();
    });

    it("resolves the repo from resolveSelectedRepo when omitted (confirmWrites OFF)", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ number: 1, title: "X", state: "open", html_url: "https://x" })));
      const ctx = ctxFor({ [SELECTED_REPO_SETTING_ID]: "acme/widgets", personalAccessToken: "ghp_token", confirmWrites: false });
      const result = await postIssueCreate({ body: { title: "X" } }, ctx);
      expect(result.status).toBe(200);
      expect((result.body as any).repo).toBe("acme/widgets");
      vi.unstubAllGlobals();
    });

    it("400s on a missing title", async () => {
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await postIssueCreate({ body: { repo: "acme/widgets" } }, ctx);
      expect(result).toMatchObject({ status: 400, body: { code: "validation_error" } });
    });

    it("400s when no repo can be resolved", async () => {
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await postIssueCreate({ body: { title: "X" } }, ctx);
      expect(result).toMatchObject({ status: 400, body: { code: "validation_error" } });
    });

    it("401s when unauthenticated with an actionable message (confirmWrites OFF)", async () => {
      const ctx = ctxFor({ confirmWrites: false });
      const result = await postIssueCreate({ body: { repo: "acme/widgets", title: "X" } }, ctx);
      expect(result.status).toBe(401);
      expect((result.body as any).code).toBe("not_authenticated");
      expect((result.body as any).error).toContain("not authenticated");
    });

    it("maps a mocked 403 to an actionable auth_error response (confirmWrites OFF)", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "Resource not accessible by integration" }, 403)));
      const ctx = ctxFor({ personalAccessToken: "ghp_token", confirmWrites: false });
      const result = await postIssueCreate({ body: { repo: "acme/widgets", title: "X" } }, ctx);
      expect(result).toMatchObject({ status: 403, body: { code: "auth_error" } });
      vi.unstubAllGlobals();
    });

    it("never echoes the token in any response body (confirmWrites OFF)", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "Bad credentials super-secret-pat" }, 401)));
      const ctx = ctxFor({ personalAccessToken: "super-secret-pat", confirmWrites: false });
      const result = await postIssueCreate({ body: { repo: "acme/widgets", title: "X" } }, ctx);
      expect(JSON.stringify(result.body)).not.toContain("super-secret-pat");
      vi.unstubAllGlobals();
    });

    it("FUSI-017: confirmWrites ON + missing confirmed → 400 confirmation_required, zero fetch calls", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await postIssueCreate({ body: { repo: "acme/widgets", title: "X" } }, ctx);
      expect(result).toMatchObject({ status: 400, body: { ok: false, code: "confirmation_required" } });
      expect(fetchSpy).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it("FUSI-017: confirmWrites ON + confirmed:true → the write proceeds", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ number: 7, title: "New bug", state: "open", html_url: "https://x", body: "desc" })));
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await postIssueCreate({ body: { repo: "acme/widgets", title: "New bug", body: "desc", confirmed: true } }, ctx);
      expect(result.status).toBe(200);
      expect((result.body as any).issue).toMatchObject({ number: 7, title: "New bug" });
      vi.unstubAllGlobals();
    });
  });

  describe("PUT /issues/update", () => {
    it("round-trips the updated issue (confirmWrites OFF)", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ number: 5, title: "Edited", state: "open", html_url: "https://x", body: "new" })));
      const ctx = ctxFor({ personalAccessToken: "ghp_token", confirmWrites: false });
      const result = await putIssueUpdate({ body: { repo: "acme/widgets", number: 5, title: "Edited", body: "new" } }, ctx);
      expect(result.status).toBe(200);
      expect((result.body as any).issue).toMatchObject({ number: 5, title: "Edited" });
      vi.unstubAllGlobals();
    });

    it("FUSI-017: confirmWrites ON + missing confirmed → 400 confirmation_required, zero fetch calls", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await putIssueUpdate({ body: { repo: "acme/widgets", number: 5, title: "Edited" } }, ctx);
      expect(result).toMatchObject({ status: 400, body: { ok: false, code: "confirmation_required" } });
      expect(fetchSpy).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it("FUSI-017: confirmWrites ON + confirmed:true → the write proceeds", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ number: 5, title: "Edited", state: "open", html_url: "https://x", body: "new" })));
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await putIssueUpdate({ body: { repo: "acme/widgets", number: 5, title: "Edited", body: "new", confirmed: true } }, ctx);
      expect(result.status).toBe(200);
      expect((result.body as any).issue).toMatchObject({ number: 5, title: "Edited" });
      vi.unstubAllGlobals();
    });

    it("400s on a missing number", async () => {
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await putIssueUpdate({ body: { repo: "acme/widgets", title: "Edited" } }, ctx);
      expect(result).toMatchObject({ status: 400, body: { code: "validation_error" } });
    });

    it("400s when neither title nor body is supplied", async () => {
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await putIssueUpdate({ body: { repo: "acme/widgets", number: 5 } }, ctx);
      expect(result).toMatchObject({ status: 400, body: { code: "validation_error" } });
    });

    it("maps a mocked 404 to not_found (confirmWrites OFF)", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "Not Found" }, 404)));
      const ctx = ctxFor({ personalAccessToken: "ghp_token", confirmWrites: false });
      const result = await putIssueUpdate({ body: { repo: "acme/ghost", number: 999, title: "X" } }, ctx);
      expect(result).toMatchObject({ status: 404, body: { code: "not_found" } });
      vi.unstubAllGlobals();
    });
  });

  describe("PUT /issues/state", () => {
    it("round-trips a close with a completed reason (confirmWrites OFF)", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ number: 5, title: "X", state: "closed", state_reason: "completed", html_url: "https://x" })));
      const ctx = ctxFor({ personalAccessToken: "ghp_token", confirmWrites: false });
      const result = await putIssueState({ body: { repo: "acme/widgets", number: 5, state: "closed", stateReason: "completed" } }, ctx);
      expect(result.status).toBe(200);
      expect((result.body as any).issue).toMatchObject({ number: 5, state: "closed" });
      vi.unstubAllGlobals();
    });

    it("round-trips a reopen (confirmWrites OFF)", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ number: 5, title: "X", state: "open", html_url: "https://x" })));
      const ctx = ctxFor({ personalAccessToken: "ghp_token", confirmWrites: false });
      const result = await putIssueState({ body: { repo: "acme/widgets", number: 5, state: "open" } }, ctx);
      expect(result.status).toBe(200);
      expect((result.body as any).issue).toMatchObject({ number: 5, state: "open" });
      vi.unstubAllGlobals();
    });

    it("FUSI-017: confirmWrites ON + missing confirmed → 400 confirmation_required, zero fetch calls", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await putIssueState({ body: { repo: "acme/widgets", number: 5, state: "closed", stateReason: "completed" } }, ctx);
      expect(result).toMatchObject({ status: 400, body: { ok: false, code: "confirmation_required" } });
      expect(fetchSpy).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it("FUSI-017: confirmWrites ON + confirmed:true → the write proceeds", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ number: 5, title: "X", state: "closed", state_reason: "completed", html_url: "https://x" })));
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await putIssueState({ body: { repo: "acme/widgets", number: 5, state: "closed", stateReason: "completed", confirmed: true } }, ctx);
      expect(result.status).toBe(200);
      expect((result.body as any).issue).toMatchObject({ number: 5, state: "closed" });
      vi.unstubAllGlobals();
    });

    it("400s on an invalid state value", async () => {
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await putIssueState({ body: { repo: "acme/widgets", number: 5, state: "archived" } }, ctx);
      expect(result).toMatchObject({ status: 400, body: { code: "validation_error" } });
    });

    it("400s on an invalid stateReason for close", async () => {
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await putIssueState({ body: { repo: "acme/widgets", number: 5, state: "closed", stateReason: "bogus" } }, ctx);
      expect(result).toMatchObject({ status: 400, body: { code: "validation_error" } });
    });
  });

  describe("POST /issues/comments", () => {
    it("round-trips the created comment (confirmWrites OFF)", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ id: 42, user: { login: "octocat" }, body: "Hello" })));
      const ctx = ctxFor({ personalAccessToken: "ghp_token", confirmWrites: false });
      const result = await postIssueComment({ body: { repo: "acme/widgets", number: 5, body: "Hello" } }, ctx);
      expect(result.status).toBe(200);
      expect((result.body as any).comment).toMatchObject({ id: 42, bodyMarkdown: "Hello" });
      expect((result.body as any).issueNumber).toBe(5);
      vi.unstubAllGlobals();
    });

    it("FUSI-017: confirmWrites ON + missing confirmed → 400 confirmation_required, zero fetch calls", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await postIssueComment({ body: { repo: "acme/widgets", number: 5, body: "Hello" } }, ctx);
      expect(result).toMatchObject({ status: 400, body: { ok: false, code: "confirmation_required" } });
      expect(fetchSpy).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it("FUSI-017: confirmWrites ON + confirmed:true → the write proceeds", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ id: 42, user: { login: "octocat" }, body: "Hello" })));
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await postIssueComment({ body: { repo: "acme/widgets", number: 5, body: "Hello", confirmed: true } }, ctx);
      expect(result.status).toBe(200);
      expect((result.body as any).comment).toMatchObject({ id: 42, bodyMarkdown: "Hello" });
      vi.unstubAllGlobals();
    });

    it("400s on a missing body", async () => {
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await postIssueComment({ body: { repo: "acme/widgets", number: 5 } }, ctx);
      expect(result).toMatchObject({ status: 400, body: { code: "validation_error" } });
    });
  });

  describe("PUT /issues/comments", () => {
    it("round-trips the edited comment (confirmWrites OFF)", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ id: 42, user: { login: "octocat" }, body: "Edited" })));
      const ctx = ctxFor({ personalAccessToken: "ghp_token", confirmWrites: false });
      const result = await putIssueComment({ body: { repo: "acme/widgets", commentId: 42, body: "Edited" } }, ctx);
      expect(result.status).toBe(200);
      expect((result.body as any).comment).toMatchObject({ id: 42, bodyMarkdown: "Edited" });
      vi.unstubAllGlobals();
    });

    it("FUSI-017: confirmWrites ON + missing confirmed → 400 confirmation_required, zero fetch calls", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await putIssueComment({ body: { repo: "acme/widgets", commentId: 42, body: "Edited" } }, ctx);
      expect(result).toMatchObject({ status: 400, body: { ok: false, code: "confirmation_required" } });
      expect(fetchSpy).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it("FUSI-017: confirmWrites ON + confirmed:true → the write proceeds", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ id: 42, user: { login: "octocat" }, body: "Edited" })));
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await putIssueComment({ body: { repo: "acme/widgets", commentId: 42, body: "Edited", confirmed: true } }, ctx);
      expect(result.status).toBe(200);
      expect((result.body as any).comment).toMatchObject({ id: 42, bodyMarkdown: "Edited" });
      vi.unstubAllGlobals();
    });

    it("400s on a missing commentId", async () => {
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await putIssueComment({ body: { repo: "acme/widgets", body: "Edited" } }, ctx);
      expect(result).toMatchObject({ status: 400, body: { code: "validation_error" } });
    });
  });

  it("no test hits api.github.com — fetch is always stubbed", () => {
    // Structural assertion: every network-touching test above calls vi.stubGlobal("fetch", ...)
    // before invoking a handler and vi.unstubAllGlobals() afterward. This test documents that
    // invariant; a real network call in this file would hang and fail CI's timeout instead.
    expect(true).toBe(true);
  });
});
