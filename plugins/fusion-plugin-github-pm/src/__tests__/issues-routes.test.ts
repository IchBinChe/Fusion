import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@fusion/plugin-sdk";
import { getIssuesFilterOptions, getIssuesList, issuesRoutes } from "../issues-routes.js";
import { SELECTED_REPO_SETTING_ID } from "../repo-config.js";

// FNXC:GithubPmIssues 2026-07-24-03:15: prevent resolveGitHubAuth's gh-CLI fallback from
// reading the real host machine's `gh` auth state -- these route tests must be deterministic
// regardless of whether the CI/dev host happens to have `gh` installed and logged in.
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

describe("github-pm issues routes", () => {
  it("registers exactly the two issues routes", () => {
    expect(issuesRoutes.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /issues/list",
      "GET /issues/filter-options",
    ]);
  });

  it("GET /issues/list without a repo returns an empty selected-repo response", async () => {
    const result = await getIssuesList({ query: {} }, ctxFor({}));
    expect(result).toMatchObject({ status: 200, body: { ok: true, repo: null, items: [] } });
  });

  it("GET /issues/list resolves the repo from resolveSelectedRepo when omitted", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([])));
    const ctx = ctxFor({ [SELECTED_REPO_SETTING_ID]: "acme/widgets", personalAccessToken: "ghp_token" });
    const result = await getIssuesList({ query: {} }, ctx);
    expect(result.status).toBe(200);
    expect((result.body as any).repo).toBe("acme/widgets");
    vi.unstubAllGlobals();
  });

  it("400s on a non-positive page", async () => {
    const ctx = ctxFor({ personalAccessToken: "ghp_token" });
    const result = await getIssuesList({ query: { repo: "acme/widgets", page: "0" } }, ctx);
    expect(result).toMatchObject({ status: 400, body: { code: "validation_error" } });
  });

  it("400s on a non-positive perPage", async () => {
    const ctx = ctxFor({ personalAccessToken: "ghp_token" });
    const result = await getIssuesList({ query: { repo: "acme/widgets", perPage: "-5" } }, ctx);
    expect(result).toMatchObject({ status: 400, body: { code: "validation_error" } });
  });

  it("401s when unauthenticated", async () => {
    const ctx = ctxFor({});
    const result = await getIssuesList({ query: { repo: "acme/widgets" } }, ctx);
    expect(result).toMatchObject({ status: 401, body: { ok: false, authenticated: false, code: "not_authenticated" } });
  });

  it("dispatches to the plain list path when search is empty", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain("/repos/acme/widgets/issues?");
      return jsonResponse([{ number: 1, title: "Bug", state: "open", html_url: "https://x", labels: [] }]);
    });
    vi.stubGlobal("fetch", fetchImpl);
    const ctx = ctxFor({ personalAccessToken: "ghp_token" });
    const result = await getIssuesList({ query: { repo: "acme/widgets", state: "open" } }, ctx);
    expect(result.status).toBe(200);
    expect((result.body as any).mode).toBe("list");
    expect((result.body as any).items).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it("dispatches to the search path when search is non-empty", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain("/search/issues?");
      return jsonResponse({ total_count: 1, incomplete_results: false, items: [{ number: 1, title: "Bug", state: "open", html_url: "https://x", labels: [] }] });
    });
    vi.stubGlobal("fetch", fetchImpl);
    const ctx = ctxFor({ personalAccessToken: "ghp_token" });
    const result = await getIssuesList({ query: { repo: "acme/widgets", search: "crash" } }, ctx);
    expect(result.status).toBe(200);
    expect((result.body as any).mode).toBe("search");
    expect((result.body as any).totalCount).toBe(1);
    vi.unstubAllGlobals();
  });

  it("maps a GitHubApiError (404) through githubErrorToResponse", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "Not Found" }, 404)));
    const ctx = ctxFor({ personalAccessToken: "ghp_token" });
    const result = await getIssuesList({ query: { repo: "acme/ghost" } }, ctx);
    expect(result).toMatchObject({ status: 404, body: { code: "not_found" } });
    vi.unstubAllGlobals();
  });

  it("never echoes the token in any response body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "Bad credentials super-secret-pat" }, 401)));
    const ctx = ctxFor({ personalAccessToken: "super-secret-pat" });
    const result = await getIssuesList({ query: { repo: "acme/widgets" } }, ctx);
    expect(JSON.stringify(result.body)).not.toContain("super-secret-pat");
    vi.unstubAllGlobals();
  });

  it("GET /issues/filter-options returns labels + milestones", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("graphql")) return jsonResponse({ data: { repository: { labels: { nodes: [{ id: "L1", name: "bug", color: "red" }], pageInfo: { hasNextPage: false, endCursor: null } } } } });
        return jsonResponse([{ number: 1, title: "v1", state: "open" }]);
      }),
    );
    const ctx = ctxFor({ personalAccessToken: "ghp_token" });
    const result = await getIssuesFilterOptions({ query: { repo: "acme/widgets" } }, ctx);
    expect(result.status).toBe(200);
    expect((result.body as any).labels).toEqual([{ id: "L1", name: "bug", color: "red" }]);
    // FNXC:GithubPmMilestones 2026-07-25-02:00: KB-003 additive-shape check -- the original
    // number/title/state fields this consumer relies on stay unchanged; new progress/due-date
    // fields are additive and do not break this filter-dropdown reader.
    expect((result.body as any).milestones).toEqual([expect.objectContaining({ number: 1, title: "v1", state: "open" })]);
    vi.unstubAllGlobals();
  });

  it("GET /issues/filter-options without a repo returns empty arrays", async () => {
    const result = await getIssuesFilterOptions({ query: {} }, ctxFor({}));
    expect(result).toMatchObject({ status: 200, body: { ok: true, repo: null, labels: [], milestones: [] } });
  });
});
