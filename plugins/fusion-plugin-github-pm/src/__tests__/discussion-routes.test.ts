import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@fusion/plugin-sdk";
import {
  discussionRoutes,
  getDiscussionCategories,
  getDiscussionCommentsRoute,
  getDiscussionDetailRoute,
  getDiscussionRepliesRoute,
  getDiscussionsList,
  postDiscussionComment,
} from "../discussion-routes.js";
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
  it("registers exactly the six discussion routes", () => {
    expect(discussionRoutes.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /discussions/categories",
      "GET /discussions/list",
      "GET /discussions/detail",
      "GET /discussions/comments",
      "GET /discussions/replies",
      "POST /discussions/comments",
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

  describe("GET /discussions/detail (KB-006)", () => {
    it("400s on a missing/invalid number", async () => {
      const result = await getDiscussionDetailRoute({ query: { repo: "acme/widgets" } }, ctxFor({ personalAccessToken: "ghp_token" }));
      expect(result).toMatchObject({ status: 400, body: { code: "validation_error" } });
    });

    it("401s when unauthenticated", async () => {
      const result = await getDiscussionDetailRoute({ query: { repo: "acme/widgets", number: "7" } }, ctxFor({}));
      expect(result).toMatchObject({ status: 401, body: { ok: false, authenticated: false, code: "not_authenticated" } });
    });

    it("bundles the discussion plus its first comment/reply page happy-path", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
        data: {
          repository: {
            discussion: {
              id: "D_1", number: 7, title: "Q", url: "https://github.com/acme/widgets/discussions/7", body: "body", upvoteCount: 1,
              author: { login: "octocat" }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", answerChosenAt: null,
              category: { name: "Q&A", emoji: "?", isAnswerable: true },
              comments: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
                { id: "DC_1", body: "c1", upvoteCount: 0, author: { login: "a" }, createdAt: "2026-01-01T00:00:00Z", replies: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } },
              ] },
            },
          },
        },
      })));
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await getDiscussionDetailRoute({ query: { repo: "acme/widgets", number: "7" } }, ctx);
      expect(result.status).toBe(200);
      expect((result.body as any).discussion.id).toBe("D_1");
      expect((result.body as any).discussion.comments).toHaveLength(1);
    });

    it("404s when the discussion is not found", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: { repository: { discussion: null } } })));
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await getDiscussionDetailRoute({ query: { repo: "acme/widgets", number: "999" } }, ctx);
      expect(result).toMatchObject({ status: 404, body: { code: "not_found" } });
    });

    it("maps a GraphQL error through githubErrorToResponse rather than degrading", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ errors: [{ message: "Discussions are disabled" }] })));
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await getDiscussionDetailRoute({ query: { repo: "acme/widgets", number: "7" } }, ctx);
      expect(result).toMatchObject({ status: 400, body: { code: "graphql_error" } });
    });
  });

  describe("GET /discussions/comments (KB-006 lazy pagination)", () => {
    it("400s on a missing/invalid number", async () => {
      const result = await getDiscussionCommentsRoute({ query: { repo: "acme/widgets" } }, ctxFor({ personalAccessToken: "ghp_token" }));
      expect(result).toMatchObject({ status: 400, body: { code: "validation_error" } });
    });

    it("fetches a subsequent page by cursor", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse({
        data: { repository: { discussion: { comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "DC_2", body: "p2", upvoteCount: 0, author: { login: "a" }, createdAt: "2026-01-01T00:00:00Z", replies: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } }] } } } },
      }));
      vi.stubGlobal("fetch", fetchImpl);
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await getDiscussionCommentsRoute({ query: { repo: "acme/widgets", number: "7", after: "cursor-1" } }, ctx);
      expect(result.status).toBe(200);
      expect((result.body as any).comments).toHaveLength(1);
      expect((result.body as any).nextCursor).toBeNull();
      const sentVariables = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body)).variables;
      expect(sentVariables.after).toBe("cursor-1");
    });
  });

  describe("GET /discussions/replies (KB-006 lazy pagination)", () => {
    it("400s on a missing commentId", async () => {
      const result = await getDiscussionRepliesRoute({ query: {} }, ctxFor({ personalAccessToken: "ghp_token" }));
      expect(result).toMatchObject({ status: 400, body: { code: "validation_error" } });
    });

    it("fetches a subsequent reply page addressed by commentId", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse({
        data: { node: { replies: { pageInfo: { hasNextPage: true, endCursor: "reply-cursor-2" }, nodes: [{ id: "DR_2", body: "r", upvoteCount: 0, author: { login: "a" }, createdAt: "2026-01-01T00:00:00Z" }] } } },
      }));
      vi.stubGlobal("fetch", fetchImpl);
      const ctx = ctxFor({ personalAccessToken: "ghp_token" });
      const result = await getDiscussionRepliesRoute({ query: { commentId: "DC_1", after: "reply-cursor-1" } }, ctx);
      expect(result.status).toBe(200);
      expect((result.body as any).replies).toHaveLength(1);
      expect((result.body as any).nextCursor).toBe("reply-cursor-2");
      const sentVariables = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body)).variables;
      expect(sentVariables.commentId).toBe("DC_1");
      expect(sentVariables.after).toBe("reply-cursor-1");
    });
  });

  describe("POST /discussions/comments (KB-006 write route)", () => {
    it("400s on a missing discussionId or empty body", async () => {
      const result = await postDiscussionComment({ body: { body: "hi" } }, ctxFor({ personalAccessToken: "ghp_token" }));
      expect(result).toMatchObject({ status: 400, body: { code: "validation_error" } });
    });

    it("blocks an unconfirmed write with confirmWrites on, performing ZERO auth/client calls", async () => {
      const fetchImpl = vi.fn();
      vi.stubGlobal("fetch", fetchImpl);
      const ctx = ctxFor({ personalAccessToken: "ghp_token", confirmWrites: true });
      const result = await postDiscussionComment({ body: { discussionId: "D_1", body: "hello" } }, ctx);
      expect(result).toMatchObject({ status: 400, body: { code: "confirmation_required" } });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("posts a top-level comment (no replyToId) when confirmed", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse({
        data: { addDiscussionComment: { comment: { id: "DC_9", body: "hello", upvoteCount: 0, author: { login: "octocat" }, createdAt: "2026-01-01T00:00:00Z", replyTo: null } } },
      }));
      vi.stubGlobal("fetch", fetchImpl);
      const ctx = ctxFor({ personalAccessToken: "ghp_token", confirmWrites: true });
      const result = await postDiscussionComment({ body: { discussionId: "D_1", body: "hello", confirmed: true } }, ctx);
      expect(result.status).toBe(200);
      expect((result.body as any).comment.replyToId).toBeNull();
      const sentVariables = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body)).variables;
      expect(Object.prototype.hasOwnProperty.call(sentVariables.input, "replyToId")).toBe(false);
    });

    it("posts a reply with the exact parent replyToId when supplied", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse({
        data: { addDiscussionComment: { comment: { id: "DC_10", body: "a reply", upvoteCount: 0, author: { login: "octocat" }, createdAt: "2026-01-01T00:00:00Z", replyTo: { id: "DC_1" } } } },
      }));
      vi.stubGlobal("fetch", fetchImpl);
      const ctx = ctxFor({ personalAccessToken: "ghp_token", confirmWrites: false });
      const result = await postDiscussionComment({ body: { discussionId: "D_1", body: "a reply", replyToId: "DC_1" } }, ctx);
      expect(result.status).toBe(200);
      expect((result.body as any).comment.replyToId).toBe("DC_1");
      const sentVariables = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body)).variables;
      expect(sentVariables.input.replyToId).toBe("DC_1");
    });

    it("maps a GitHubApiError through githubErrorToResponse", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "Not Found" }, 404)));
      const ctx = ctxFor({ personalAccessToken: "ghp_token", confirmWrites: false });
      const result = await postDiscussionComment({ body: { discussionId: "D_1", body: "hello" } }, ctx);
      expect(result).toMatchObject({ status: 404, body: { code: "not_found" } });
    });

    it("never echoes the token in any response body", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "Bad credentials super-secret-pat" }, 401)));
      const ctx = ctxFor({ personalAccessToken: "super-secret-pat", confirmWrites: false });
      const result = await postDiscussionComment({ body: { discussionId: "D_1", body: "hello" } }, ctx);
      expect(JSON.stringify(result.body)).not.toContain("super-secret-pat");
    });
  });
});
