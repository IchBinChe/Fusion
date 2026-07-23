import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@fusion/plugin-sdk";
import { discussionRoutes, getDiscussionCategories, getDiscussionsList } from "../discussion-routes.js";
import { buildDiscussionSearchQuery } from "../github-client.js";
import { SELECTED_REPO_SETTING_ID } from "../repo-config.js";

// FNXC:GithubPmDiscussions 2026-07-25-11:20: prevent resolveGitHubAuth's gh-CLI fallback from
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
  vi.unstubAllGlobals();
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

describe("github-pm discussion routes", () => {
  it("registers exactly the two discussion routes", () => {
    expect(discussionRoutes.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /discussions/categories",
      "GET /discussions/list",
    ]);
  });

  describe("GET /discussions/categories", () => {
    it("returns an empty selected-repo response when no repo resolves", async () => {
      const result = await getDiscussionCategories({ query: {} }, ctxFor({}));
      expect(result).toMatchObject({ status: 200, body: { ok: true, repo: null, categories: [] } });
    });

    it("resolves the repo from resolveSelectedRepo when omitted", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: { repository: { discussionCategories: { nodes: [] } } } })));
      const ctx = ctxFor({ [SELECTED_REPO_SETTING_ID]: "acme/widgets", personalAccessToken: "ghp_token" });
      const result = await getDiscussionCategories({ query: {} }, ctx);
      expect(result.status).toBe(200);
      expect((result.body as any).repo).toBe("acme/widgets");
    });

    it("401s when unauthenticated", async () => {
      const result = await getDiscussionCategories({ query: { repo: "acme/widgets" } }, ctxFor({}));
      expect(result).toMatchObject({ status: 401, body: { ok: false, authenticated: false, code: "not_authenticated" } });
    });

    it("maps every category field", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          jsonResponse({
            data: {
              repository: {
                discussionCategories: {
                  nodes: [
                    { id: "C1", name: "Q&A", slug: "q-a", emoji: "\ud83d\udcac", emojiHTML: "<div/>", isAnswerable: true, description: "Ask questions" },
                  ],
                },
              },
            },
          }),
        ),
      );
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await getDiscussionCategories({ query: { repo: "acme/widgets" } }, ctx);
      expect(result.status).toBe(200);
      expect((result.body as any).categories).toEqual([
        { id: "C1", name: "Q&A", slug: "q-a", emoji: "\ud83d\udcac", emojiHTML: "<div/>", isAnswerable: true, description: "Ask questions" },
      ]);
    });

    it("degrades a 403 (discussions disabled/no scope) to an empty categories array, not a 500", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "Resource not accessible by integration" }, 403)));
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await getDiscussionCategories({ query: { repo: "acme/widgets" } }, ctx);
      expect(result).toMatchObject({ status: 200, body: { ok: true, repo: "acme/widgets", categories: [] } });
    });

    it("degrades a 404 to an empty categories array", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "Not Found" }, 404)));
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await getDiscussionCategories({ query: { repo: "acme/widgets" } }, ctx);
      expect(result).toMatchObject({ status: 200, body: { ok: true, categories: [] } });
    });

    it("maps an unrelated failure (e.g. 500) through githubErrorToResponse rather than degrading", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "Server exploded" }, 500)));
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await getDiscussionCategories({ query: { repo: "acme/widgets" } }, ctx);
      expect(result).toMatchObject({ status: 500, body: { code: "github_api_error" } });
    });

    it("never echoes the token in any response body", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "Bad credentials super-secret-pat" }, 401)));
      const ctx = ctxFor({ personalAccessToken: "super-secret-pat" });
      const result = await getDiscussionCategories({ query: { repo: "acme/widgets" } }, ctx);
      expect(JSON.stringify(result.body)).not.toContain("super-secret-pat");
    });
  });

  describe("GET /discussions/list", () => {
    it("returns an empty selected-repo response when no repo resolves", async () => {
      const result = await getDiscussionsList({ query: {} }, ctxFor({}));
      expect(result).toMatchObject({ status: 200, body: { ok: true, repo: null, items: [], query: null } });
    });

    it("401s when unauthenticated", async () => {
      const result = await getDiscussionsList({ query: { repo: "acme/widgets" } }, ctxFor({}));
      expect(result).toMatchObject({ status: 401, body: { ok: false, authenticated: false, code: "not_authenticated" } });
    });

    it("echoes the exact built query string for a representative filter combination", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse({ data: { search: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } }));
      vi.stubGlobal("fetch", fetchImpl);
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await getDiscussionsList({ query: { repo: "acme/widgets", category: "Q&A", answered: "unanswered", sort: "newest", search: "dark mode" } }, ctx);
      expect(result.status).toBe(200);
      expect((result.body as any).query).toBe(
        buildDiscussionSearchQuery("acme", "widgets", { category: "Q&A", answered: "unanswered", sort: "newest", search: "dark mode" }),
      );
      const body = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body));
      expect(body.variables.query).toBe((result.body as any).query);
    });

    it("ignores an invalid sort/answered value rather than 400ing", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: { search: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } })));
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await getDiscussionsList({ query: { repo: "acme/widgets", sort: "bogus", answered: "bogus" } }, ctx);
      expect(result.status).toBe(200);
      expect((result.body as any).query).toBe("repo:acme/widgets sort:updated");
    });

    it("maps mapped discussion items into the response", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          jsonResponse({
            data: {
              search: {
                nodes: [
                  {
                    number: 1,
                    title: "How do I configure X?",
                    url: "https://github.com/acme/widgets/discussions/1",
                    category: { name: "Q&A", emoji: "\ud83d\udcac", isAnswerable: true },
                    upvoteCount: 2,
                    comments: { totalCount: 4 },
                    answer: null,
                    answerChosenAt: null,
                    author: { login: "octocat" },
                    createdAt: "2026-01-01T00:00:00Z",
                    updatedAt: "2026-01-02T00:00:00Z",
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
        ),
      );
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await getDiscussionsList({ query: { repo: "acme/widgets" } }, ctx);
      expect(result.status).toBe(200);
      expect((result.body as any).items).toEqual([
        {
          number: 1,
          title: "How do I configure X?",
          url: "https://github.com/acme/widgets/discussions/1",
          categoryName: "Q&A",
          categoryEmoji: "\ud83d\udcac",
          upvoteCount: 2,
          commentCount: 4,
          isAnswered: false,
          authorLogin: "octocat",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-02T00:00:00Z",
        },
      ]);
    });

    it("maps a GitHubApiError (404) through githubErrorToResponse", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "Not Found" }, 404)));
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await getDiscussionsList({ query: { repo: "acme/ghost" } }, ctx);
      expect(result).toMatchObject({ status: 404, body: { code: "not_found" } });
    });

    it("maps a GraphQL discussions-disabled error through githubErrorToResponse", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ errors: [{ message: "Discussions are disabled for this repository" }] })));
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await getDiscussionsList({ query: { repo: "acme/widgets" } }, ctx);
      expect(result).toMatchObject({ status: 400, body: { code: "graphql_error" } });
    });

    it("never echoes the token in any response body", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "Bad credentials super-secret-pat" }, 401)));
      const ctx = ctxFor({ personalAccessToken: "super-secret-pat" });
      const result = await getDiscussionsList({ query: { repo: "acme/widgets" } }, ctx);
      expect(JSON.stringify(result.body)).not.toContain("super-secret-pat");
    });
  });
});
