import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@fusion/plugin-sdk";
import { getIssueComments, getIssueDetail, issueRoutes } from "../issue-routes.js";
import { REPO_CONFIG_STATE_SETTING_ID } from "../repo-config.js";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

const ISSUE_FIXTURE = {
  number: 7,
  title: "Distinctive-Fixture issue",
  state: "open",
  body: "Body text",
  html_url: "https://github.com/acme/widgets/issues/7",
  user: { login: "octocat", avatar_url: "https://a" },
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  labels: [{ name: "bug", color: "ff0000" }],
  assignees: [],
  milestone: null,
  comments: 1,
};

/** Serves GET /issues/{n}, /issues/{n}/comments, /issues/{n}/timeline from injected fixtures. */
function stubGitHubFetch(options: { commentsNextLink?: string; comments?: unknown[]; timeline?: unknown[]; issueStatus?: number } = {}) {
  const comments = options.comments ?? [{ id: 1, user: { login: "octocat" }, body: "a comment", created_at: "2026-01-01T00:00:00Z" }];
  const timeline = options.timeline ?? [{ id: 1, event: "closed", actor: { login: "octocat" }, created_at: "2026-01-01T00:00:00Z" }];
  const fetchImpl = vi.fn(async (url: string) => {
    if (typeof url === "string" && url.includes("/comments")) {
      const headers = options.commentsNextLink ? { Link: `<${options.commentsNextLink}>; rel="next"` } : {};
      return jsonResponse(comments, 200, headers);
    }
    if (typeof url === "string" && url.includes("/timeline")) {
      return jsonResponse(timeline);
    }
    if (typeof url === "string" && url.includes("/issues/")) {
      return jsonResponse(ISSUE_FIXTURE, options.issueStatus ?? 200);
    }
    return jsonResponse({}, 404);
  });
  vi.stubGlobal("fetch", fetchImpl);
  return fetchImpl;
}

function ctxFor(settings: Record<string, unknown>): PluginContext {
  return {
    pluginId: "fusion-plugin-github-pm",
    settings,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    emitEvent: vi.fn(),
    taskStore: { getRootDir: () => "/tmp/repo" },
  } as unknown as PluginContext;
}

describe("github-pm issue routes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers exactly the two issue routes", () => {
    expect(issueRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /issues/detail", "GET /issues/comments"]);
  });

  it("/issues/detail returns issue + timeline + first comment page", async () => {
    stubGitHubFetch({ commentsNextLink: "https://api.github.com/repos/acme/widgets/issues/7/comments?per_page=30&page=2" });
    const result = await getIssueDetail({ query: { repo: "acme/widgets", number: "7" } }, ctxFor({}));

    expect(result.status).toBe(200);
    expect((result.body as any).issue).toMatchObject({ number: 7, title: "Distinctive-Fixture issue" });
    expect((result.body as any).timeline).toHaveLength(1);
    expect((result.body as any).comments).toHaveLength(1);
    expect((result.body as any).commentsNextPage).toBe(2);
  });

  it("resolves repo from resolveSelectedRepo when the query omits it", async () => {
    stubGitHubFetch();
    const settings = { [REPO_CONFIG_STATE_SETTING_ID]: "{}", selectedRepo: "acme/widgets" };
    const result = await getIssueDetail({ query: { number: "7" } }, ctxFor(settings));

    expect(result.status).toBe(200);
    expect((result.body as any).repo).toBe("acme/widgets");
  });

  it("400s on missing repo", async () => {
    stubGitHubFetch();
    const result = await getIssueDetail({ query: { number: "7" } }, ctxFor({}));
    expect(result.status).toBe(400);
    expect((result.body as any).code).toBe("validation_error");
  });

  it("400s on missing/invalid number", async () => {
    stubGitHubFetch();
    const result = await getIssueDetail({ query: { repo: "acme/widgets" } }, ctxFor({}));
    expect(result.status).toBe(400);
    expect((result.body as any).code).toBe("validation_error");
  });

  it("maps a GitHubApiError (e.g. 404) through githubErrorToResponse", async () => {
    stubGitHubFetch({ issueStatus: 404 });
    const result = await getIssueDetail({ query: { repo: "acme/widgets", number: "999" } }, ctxFor({}));
    expect(result.status).toBe(404);
    expect((result.body as any).code).toBe("not_found");
  });

  it("never echoes the token value in any response body", async () => {
    stubGitHubFetch();
    const settings = { personalAccessToken: "ghp_super_secret_value" };
    const result = await getIssueDetail({ query: { repo: "acme/widgets", number: "7" } }, ctxFor(settings));
    expect(JSON.stringify(result.body)).not.toContain("ghp_super_secret_value");
  });

  it("/issues/comments?page= returns the requested page + nextPage", async () => {
    stubGitHubFetch({ comments: [{ id: 2, user: { login: "hubot" }, body: "page two comment" }] });
    const result = await getIssueComments({ query: { repo: "acme/widgets", number: "7", page: "2" } }, ctxFor({}));

    expect(result.status).toBe(200);
    expect((result.body as any).comments).toEqual([{ id: 2, author: { login: "hubot", avatarUrl: undefined }, bodyMarkdown: "page two comment", createdAt: undefined, updatedAt: undefined }]);
    expect((result.body as any).nextPage).toBeNull();
  });

  it("/issues/comments 400s on missing repo/number", async () => {
    stubGitHubFetch();
    const result = await getIssueComments({ query: { repo: "acme/widgets" } }, ctxFor({}));
    expect(result.status).toBe(400);
  });
});
