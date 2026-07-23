import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GITHUB_GRAPHQL_ENDPOINT,
  GITHUB_REST_BASE_URL,
  GitHubApiError,
  GitHubClient,
  buildDiscussionSearchQuery,
  githubErrorToResponse,
  isGitHubApiError,
  normalizeGitHubLabelColor,
  parseNextLinkUrl,
} from "../github-client.js";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

describe("GitHubClient error mapping", () => {
  it("maps 401 to auth_error without leaking the token", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "Bad credentials secret-gh-token" }, 401)) as unknown as typeof fetch;
    const client = new GitHubClient("secret-gh-token", fetchImpl);
    await expect(client.listIssues("acme", "widgets")).rejects.toMatchObject({ status: 401, code: "auth_error" });
    await client.listIssues("acme", "widgets").catch((error) => {
      expect(String(error.message)).not.toContain("secret-gh-token");
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining(`${GITHUB_REST_BASE_URL}/repos/acme/widgets/issues`),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer secret-gh-token" }) }),
    );
  });

  it("maps a plain scope-denied 403 (no rate-limit headers) to auth_error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "Resource not accessible by integration" }, 403)) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);
    await expect(client.listIssues("acme", "widgets")).rejects.toMatchObject({ status: 403, code: "auth_error" });
  });

  it("maps 404 to not_found", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "Not Found" }, 404)) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);
    await expect(client.listIssues("acme", "ghost")).rejects.toMatchObject({ status: 404, code: "not_found" });
  });

  it("maps a thrown fetch rejection to network_error with status 0", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);
    await expect(client.listIssues("acme", "widgets")).rejects.toMatchObject({ status: 0, code: "network_error" });
  });

  it("maps other non-OK statuses to github_api_error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "Server exploded" }, 500)) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);
    await expect(client.listIssues("acme", "widgets")).rejects.toMatchObject({ status: 500, code: "github_api_error" });
  });

  it("isGitHubApiError narrows and githubErrorToResponse maps status 0 to 502", () => {
    const error = new GitHubApiError(0, "unreachable", "network_error");
    expect(isGitHubApiError(error)).toBe(true);
    expect(isGitHubApiError(new Error("plain"))).toBe(false);
    expect(githubErrorToResponse(error)).toEqual({ status: 502, error: "unreachable", code: "network_error" });
    expect(githubErrorToResponse(new Error("plain"))).toEqual({ status: 500, error: "GitHub request failed unexpectedly.", code: "unexpected_error" });
  });
});

describe("GitHubClient rate-limit backoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("backs off on a single 429 with Retry-After then succeeds", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ message: "rate limited" }, 429, { "Retry-After": "1" }))
      .mockResolvedValueOnce(jsonResponse([{ number: 1, title: "Bug", state: "open", html_url: "https://github.com/acme/widgets/issues/1", labels: [] }]));
    const client = new GitHubClient("token", fetchImpl as unknown as typeof fetch);

    const resultPromise = client.listIssues("acme", "widgets");
    await vi.advanceTimersByTimeAsync(1000);
    const result = await resultPromise;

    expect(result).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("backs off on a 403 that carries rate-limit headers (not auth_error)", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ message: "rate limited" }, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 1) }))
      .mockResolvedValueOnce(jsonResponse([]));
    const client = new GitHubClient("token", fetchImpl as unknown as typeof fetch);

    const resultPromise = client.listIssues("acme", "widgets");
    await vi.advanceTimersByTimeAsync(2000);
    const result = await resultPromise;

    expect(result).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws rate_limited after exhausting maxRetries", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "rate limited" }, 429, { "Retry-After": "0" })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl, { maxRetries: 2, retryDelayMs: 10 });

    const resultPromise = client.listIssues("acme", "widgets");
    const assertion = expect(resultPromise).rejects.toMatchObject({ code: "rate_limited" });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(fetchImpl).toHaveBeenCalledTimes(3); // initial attempt + 2 retries
  });

  it("never leaks the token in a rate-limit-exhaustion error message", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 429)) as unknown as typeof fetch;
    const client = new GitHubClient("super-secret-token", fetchImpl, { maxRetries: 1, retryDelayMs: 5 });
    const resultPromise = client.listIssues("acme", "widgets");
    const assertion = resultPromise.catch((error) => {
      expect(String(error.message)).not.toContain("super-secret-token");
    });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });
});

describe("GitHubClient REST pagination (Link header)", () => {
  it("aggregates more than 100 items across two pages via rel=\"next\"", async () => {
    const pageOne = Array.from({ length: 100 }, (_, i) => ({ number: i + 1, title: `Issue ${i + 1}`, state: "open", html_url: `https://github.com/acme/widgets/issues/${i + 1}`, labels: [] }));
    const pageTwo = Array.from({ length: 20 }, (_, i) => ({ number: 100 + i + 1, title: `Issue ${100 + i + 1}`, state: "open", html_url: `https://github.com/acme/widgets/issues/${100 + i + 1}`, labels: [] }));
    const nextUrl = `${GITHUB_REST_BASE_URL}/repositories/1/issues?per_page=100&page=2`;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(pageOne, 200, { Link: `<${nextUrl}>; rel="next", <${nextUrl}>; rel="last"` }))
      .mockResolvedValueOnce(jsonResponse(pageTwo));
    const client = new GitHubClient("token", fetchImpl as unknown as typeof fetch);

    const result = await client.listIssues("acme", "widgets", { maxItems: 120 });

    expect(result).toHaveLength(120);
    expect(result[0].number).toBe(1);
    expect(result[119].number).toBe(120);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][0]).toBe(nextUrl);
  });

  it("stops when there is no next link", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([{ number: 1, title: "Only", state: "open", html_url: "https://github.com/acme/widgets/issues/1", labels: [] }])) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const result = await client.listIssues("acme", "widgets");

    expect(result).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("stops once maxItems is reached even if a next link remains", async () => {
    const pageOne = Array.from({ length: 100 }, (_, i) => ({ number: i + 1, title: `Issue ${i + 1}`, state: "open", html_url: `https://github.com/acme/widgets/issues/${i + 1}`, labels: [] }));
    const nextUrl = `${GITHUB_REST_BASE_URL}/repositories/1/issues?per_page=100&page=2`;
    const fetchImpl = vi.fn(async () => jsonResponse(pageOne, 200, { Link: `<${nextUrl}>; rel="next"` })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl, { maxRetries: 0 });

    const result = await client.listIssues("acme", "widgets", { maxItems: 50 });

    expect(result).toHaveLength(50);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("filters out pull requests returned by the issues endpoint", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([
      { number: 1, title: "Real issue", state: "open", html_url: "https://github.com/acme/widgets/issues/1", labels: [{ name: "bug" }] },
      { number: 2, title: "A PR", state: "open", html_url: "https://github.com/acme/widgets/pull/2", labels: [], pull_request: { url: "..." } },
    ])) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const result = await client.listIssues("acme", "widgets");

    expect(result).toEqual([{ number: 1, title: "Real issue", state: "open", htmlUrl: "https://github.com/acme/widgets/issues/1", labels: ["bug"], createdAt: undefined, updatedAt: undefined }]);
  });

  it("parseNextLinkUrl extracts rel=\"next\" and returns undefined when absent", () => {
    expect(parseNextLinkUrl('<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"')).toBe("https://api.github.com/x?page=2");
    expect(parseNextLinkUrl('<https://api.github.com/x?page=5>; rel="last"')).toBeUndefined();
    expect(parseNextLinkUrl(null)).toBeUndefined();
  });
});

describe("GitHubClient GraphQL", () => {
  it("posts query/variables to the GraphQL endpoint and returns data", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { viewer: { login: "octocat" } } })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const data = await client.graphql<{ viewer: { login: string } }>("query { viewer { login } }", { foo: "bar" });

    expect(data.viewer.login).toBe("octocat");
    expect(fetchImpl).toHaveBeenCalledWith(GITHUB_GRAPHQL_ENDPOINT, expect.objectContaining({ method: "POST" }));
    const body = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body));
    expect(body.variables).toEqual({ foo: "bar" });
  });

  it("maps top-level errors[] to graphql_error without leaking the token", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ errors: [{ message: "Field 'x' doesn't exist on type 'Query' for token super-secret" }] })) as unknown as typeof fetch;
    const client = new GitHubClient("super-secret", fetchImpl);

    await expect(client.graphql("query { x }")).rejects.toMatchObject({ code: "graphql_error" });
    await client.graphql("query { x }").catch((error) => {
      expect(String(error.message)).not.toContain("super-secret");
    });
  });

  it("follows endCursor pagination across two pages within bounds", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: { repository: { labels: { nodes: [{ id: "L1", name: "bug", color: "red" }], pageInfo: { hasNextPage: true, endCursor: "cursor-1" } } } } }))
      .mockResolvedValueOnce(jsonResponse({ data: { repository: { labels: { nodes: [{ id: "L2", name: "docs", color: "blue" }], pageInfo: { hasNextPage: false, endCursor: null } } } } }));
    const client = new GitHubClient("token", fetchImpl as unknown as typeof fetch);

    const labels = await client.listLabels("acme", "widgets");

    expect(labels.map((label) => label.name)).toEqual(["bug", "docs"]);
    const secondBody = JSON.parse(String(fetchImpl.mock.calls[1][1].body));
    expect(secondBody.variables.after).toBe("cursor-1");
  });

  it("stops pagination once hasNextPage is false on the first page", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { repository: { labels: { nodes: [{ id: "L1", name: "bug", color: "red" }], pageInfo: { hasNextPage: false, endCursor: null } } } } })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const labels = await client.listLabels("acme", "widgets");

    expect(labels).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("GitHubClient discussions (FUSI-005)", () => {
  it("lists discussions, folding category name into the same query", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      data: {
        repository: {
          discussions: {
            nodes: [
              { number: 1, title: "How do I configure X?", createdAt: "2026-01-01T00:00:00Z", category: { name: "Q&A" } },
              { number: 2, title: "Feature idea: Y", createdAt: "2026-01-02T00:00:00Z", category: { name: "Ideas" } },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const discussions = await client.listDiscussions("acme", "widgets");

    expect(discussions).toEqual([
      { number: 1, title: "How do I configure X?", category: "Q&A", createdAt: "2026-01-01T00:00:00Z" },
      { number: 2, title: "Feature idea: Y", category: "Ideas", createdAt: "2026-01-02T00:00:00Z" },
    ]);
  });

  it("treats a missing category as null rather than throwing", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      data: { repository: { discussions: { nodes: [{ number: 1, title: "Uncategorized", category: null }], pageInfo: { hasNextPage: false, endCursor: null } } } },
    })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const discussions = await client.listDiscussions("acme", "widgets");

    expect(discussions[0].category).toBeNull();
  });

  it("paginates across endCursor pages like listLabels", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: { repository: { discussions: { nodes: [{ number: 1, title: "first", category: { name: "General" } }], pageInfo: { hasNextPage: true, endCursor: "cursor-1" } } } } }))
      .mockResolvedValueOnce(jsonResponse({ data: { repository: { discussions: { nodes: [{ number: 2, title: "second", category: { name: "General" } }], pageInfo: { hasNextPage: false, endCursor: null } } } } }));
    const client = new GitHubClient("token", fetchImpl as unknown as typeof fetch);

    const discussions = await client.listDiscussions("acme", "widgets");

    expect(discussions.map((discussion) => discussion.number)).toEqual([1, 2]);
  });

  it("degrades to an empty array (never throws) when the token lacks discussion scope", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ errors: [{ message: "Resource not accessible by integration" }] })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    await expect(client.listDiscussions("acme", "widgets")).resolves.toEqual([]);
  });

  it("degrades to an empty array on a 404 (repo has discussions disabled)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "Not Found" }, 404)) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    await expect(client.listDiscussions("acme", "widgets")).resolves.toEqual([]);
  });

  it("still throws on an unrelated failure (e.g. network_error), not silently swallowed", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    await expect(client.listDiscussions("acme", "widgets")).rejects.toMatchObject({ code: "network_error" });
  });
});

describe("buildDiscussionSearchQuery (KB-005 search-query fidelity)", () => {
  it("builds the base query with the default sort:updated when no options are given", () => {
    expect(buildDiscussionSearchQuery("acme", "widgets")).toBe("repo:acme/widgets sort:updated");
  });

  it("quotes the category qualifier, escaping embedded quotes", () => {
    expect(buildDiscussionSearchQuery("acme", "widgets", { category: "Q&A" })).toBe('repo:acme/widgets category:"Q&A" sort:updated');
    expect(buildDiscussionSearchQuery("acme", "widgets", { category: 'Weird "Name"' })).toBe('repo:acme/widgets category:"Weird \\"Name\\"" sort:updated');
  });

  it("adds is:answered / is:unanswered qualifiers", () => {
    expect(buildDiscussionSearchQuery("acme", "widgets", { answered: "answered" })).toBe("repo:acme/widgets is:answered sort:updated");
    expect(buildDiscussionSearchQuery("acme", "widgets", { answered: "unanswered" })).toBe("repo:acme/widgets is:unanswered sort:updated");
  });

  it("maps sort:'newest' to sort:created and 'activity' (default) to sort:updated", () => {
    expect(buildDiscussionSearchQuery("acme", "widgets", { sort: "newest" })).toBe("repo:acme/widgets sort:created");
    expect(buildDiscussionSearchQuery("acme", "widgets", { sort: "activity" })).toBe("repo:acme/widgets sort:updated");
  });

  it("appends trimmed free text last, after every qualifier", () => {
    expect(buildDiscussionSearchQuery("acme", "widgets", { category: "Ideas", answered: "unanswered", sort: "newest", search: "  dark mode  " })).toBe(
      'repo:acme/widgets category:"Ideas" is:unanswered sort:created dark mode',
    );
  });

  it("omits an empty/whitespace-only category rather than emitting an empty qualifier", () => {
    expect(buildDiscussionSearchQuery("acme", "widgets", { category: "   " })).toBe("repo:acme/widgets sort:updated");
  });
});

describe("GitHubClient.listDiscussionCategories (KB-005)", () => {
  it("maps every field and filters out categories missing id/name", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      data: {
        repository: {
          discussionCategories: {
            nodes: [
              { id: "C1", name: "Q&A", slug: "q-a", emoji: "\ud83d\udcac", emojiHTML: "<div>ud83d</div>", isAnswerable: true, description: "Ask questions" },
              { id: "C2", name: "Ideas", slug: "ideas", emoji: "\ud83d\udca1", emojiHTML: "<div>ud83d</div>", isAnswerable: false },
              { name: "Missing id" },
              { id: "C3" },
            ],
          },
        },
      },
    })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const categories = await client.listDiscussionCategories("acme", "widgets");

    expect(categories).toEqual([
      { id: "C1", name: "Q&A", slug: "q-a", emoji: "\ud83d\udcac", emojiHTML: "<div>ud83d</div>", isAnswerable: true, description: "Ask questions" },
      { id: "C2", name: "Ideas", slug: "ideas", emoji: "\ud83d\udca1", emojiHTML: "<div>ud83d</div>", isAnswerable: false, description: undefined },
    ]);
  });

  it("maps a 403 to auth_error without leaking the token", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "Bad credentials secret-token" }, 403)) as unknown as typeof fetch;
    const client = new GitHubClient("secret-token", fetchImpl);
    await expect(client.listDiscussionCategories("acme", "widgets")).rejects.toMatchObject({ code: "auth_error" });
    await client.listDiscussionCategories("acme", "widgets").catch((error) => {
      expect(String(error.message)).not.toContain("secret-token");
    });
  });

  it("maps a 404 to not_found", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "Not Found" }, 404)) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);
    await expect(client.listDiscussionCategories("acme", "widgets")).rejects.toMatchObject({ code: "not_found" });
  });

  it("maps a GraphQL errors[] payload (discussions disabled) to graphql_error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ errors: [{ message: "Discussions are disabled for this repository" }] })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);
    await expect(client.listDiscussionCategories("acme", "widgets")).rejects.toMatchObject({ code: "graphql_error" });
  });
});

describe("GitHubClient.searchDiscussions (KB-005)", () => {
  function discussionNode(overrides: Record<string, unknown> = {}) {
    return {
      number: 1,
      title: "How do I configure X?",
      url: "https://github.com/acme/widgets/discussions/1",
      category: { name: "Q&A", emoji: "\ud83d\udcac", isAnswerable: true },
      upvoteCount: 3,
      comments: { totalCount: 5 },
      answer: null,
      answerChosenAt: null,
      author: { login: "octocat" },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
      ...overrides,
    };
  }

  it("sends the built search query and type:DISCUSSION, mapping every field", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      data: { search: { nodes: [discussionNode()], pageInfo: { hasNextPage: false, endCursor: null } } },
    })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const items = await client.searchDiscussions("acme", "widgets", { category: "Q&A", answered: "unanswered", sort: "newest", search: "config" });

    expect(items).toEqual([
      {
        number: 1,
        title: "How do I configure X?",
        url: "https://github.com/acme/widgets/discussions/1",
        categoryName: "Q&A",
        categoryEmoji: "\ud83d\udcac",
        upvoteCount: 3,
        commentCount: 5,
        isAnswered: false,
        authorLogin: "octocat",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
      },
    ]);
    const body = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body));
    expect(body.variables.query).toBe(buildDiscussionSearchQuery("acme", "widgets", { category: "Q&A", answered: "unanswered", sort: "newest", search: "config" }));
    expect(body.query).toContain("type: DISCUSSION");
  });

  it("derives isAnswered true from a present answer", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      data: { search: { nodes: [discussionNode({ answer: { id: "A1" } })], pageInfo: { hasNextPage: false, endCursor: null } } },
    })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const items = await client.searchDiscussions("acme", "widgets");
    expect(items[0].isAnswered).toBe(true);
  });

  it("derives isAnswered true from a present answerChosenAt even without an answer node", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      data: { search: { nodes: [discussionNode({ answerChosenAt: "2026-01-03T00:00:00Z" })], pageInfo: { hasNextPage: false, endCursor: null } } },
    })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const items = await client.searchDiscussions("acme", "widgets");
    expect(items[0].isAnswered).toBe(true);
  });

  it("paginates across endCursor pages", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: { search: { nodes: [discussionNode({ number: 1 })], pageInfo: { hasNextPage: true, endCursor: "cursor-1" } } } }))
      .mockResolvedValueOnce(jsonResponse({ data: { search: { nodes: [discussionNode({ number: 2 })], pageInfo: { hasNextPage: false, endCursor: null } } } }));
    const client = new GitHubClient("token", fetchImpl as unknown as typeof fetch);

    const items = await client.searchDiscussions("acme", "widgets");
    expect(items.map((item) => item.number)).toEqual([1, 2]);
  });

  it("maps a 403 to auth_error without leaking the token", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "Bad credentials secret-token" }, 403)) as unknown as typeof fetch;
    const client = new GitHubClient("secret-token", fetchImpl);
    await expect(client.searchDiscussions("acme", "widgets")).rejects.toMatchObject({ code: "auth_error" });
  });

  it("maps a 404 to not_found", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "Not Found" }, 404)) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);
    await expect(client.searchDiscussions("acme", "widgets")).rejects.toMatchObject({ code: "not_found" });
  });

  it("maps a GraphQL errors[] payload to graphql_error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ errors: [{ message: "Discussions are disabled" }] })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);
    await expect(client.searchDiscussions("acme", "widgets")).rejects.toMatchObject({ code: "graphql_error" });
  });
});

describe("GitHubClient issue detail (FUSI-013)", () => {
  it("getIssue maps REST fields to bodyMarkdown/labels/assignees/milestone/state", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      number: 42,
      title: "Distinctive-Fixture bug",
      state: "closed",
      body: "## Repro\n- step 1",
      html_url: "https://github.com/acme/widgets/issues/42",
      user: { login: "octocat", avatar_url: "https://a" },
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
      labels: [{ name: "bug", color: "ff0000", description: "A bug" }],
      assignees: [{ login: "hubot", avatar_url: "https://b" }],
      milestone: { title: "v1", state: "open", due_on: "2026-02-01T00:00:00Z" },
      comments: 3,
    })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const issue = await client.getIssue("acme", "widgets", 42);

    expect(issue).toEqual({
      number: 42,
      title: "Distinctive-Fixture bug",
      state: "closed",
      bodyMarkdown: "## Repro\n- step 1",
      htmlUrl: "https://github.com/acme/widgets/issues/42",
      author: { login: "octocat", avatarUrl: "https://a" },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
      labels: [{ name: "bug", color: "ff0000", description: "A bug" }],
      assignees: [{ login: "hubot", avatarUrl: "https://b" }],
      milestone: { title: "v1", state: "open", dueOn: "2026-02-01T00:00:00Z" },
      commentCount: 3,
    });
  });

  it("getIssue rejects a pull_request-shaped payload", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ number: 2, title: "PR", state: "open", html_url: "u", pull_request: { url: "..." } })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    await expect(client.getIssue("acme", "widgets", 2)).rejects.toMatchObject({ status: 404, code: "not_found" });
  });

  it("listIssueComments returns one page and derives nextPage from the Link header", async () => {
    const nextUrl = `${GITHUB_REST_BASE_URL}/repos/acme/widgets/issues/1/comments?per_page=100&page=2`;
    const fetchImpl = vi.fn(async () => jsonResponse(
      [{ id: 1, user: { login: "octocat" }, body: "comment 1", created_at: "2026-01-01T00:00:00Z" }],
      200,
      { Link: `<${nextUrl}>; rel="next"` },
    )) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const page = await client.listIssueComments("acme", "widgets", 1);

    expect(page.comments).toEqual([{ id: 1, author: { login: "octocat", avatarUrl: undefined }, bodyMarkdown: "comment 1", createdAt: "2026-01-01T00:00:00Z", updatedAt: undefined }]);
    expect(page.nextPage).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("listIssueComments returns nextPage: null without a Link header (does not eagerly accumulate)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([{ id: 1, user: { login: "octocat" }, body: "only comment" }])) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const page = await client.listIssueComments("acme", "widgets", 1);

    expect(page.nextPage).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("listIssueTimeline keeps only key event types and drops others", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([
      { id: 1, event: "closed", actor: { login: "octocat" }, created_at: "2026-01-01T00:00:00Z" },
      { id: 2, event: "commented", actor: { login: "octocat" }, created_at: "2026-01-01T01:00:00Z" },
      { id: 3, event: "labeled", actor: { login: "octocat" }, created_at: "2026-01-01T02:00:00Z", label: { name: "bug", color: "ff0000" } },
      { id: 4, event: "cross-referenced", created_at: "2026-01-01T03:00:00Z", source: { issue: { number: 7, html_url: "https://github.com/acme/widgets/issues/7" } } },
      { id: 5, event: "assigned", created_at: "2026-01-01T04:00:00Z" },
    ])) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const events = await client.listIssueTimeline("acme", "widgets", 1);

    expect(events.map((event) => event.event)).toEqual(["closed", "labeled", "cross-referenced"]);
    expect(events[1].label).toEqual({ name: "bug", color: "ff0000" });
    expect(events[2].source).toEqual({ issueNumber: 7, htmlUrl: "https://github.com/acme/widgets/issues/7" });
  });
});

describe("GitHubClient.listIssuesPage (FUSI-012)", () => {
  it("maps filters/sort/direction/page/per_page into the request URL and returns one page", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([
      { number: 1, title: "Issue 1", state: "open", html_url: "https://github.com/acme/widgets/issues/1", labels: [{ name: "bug", color: "red" }], assignees: [{ login: "octocat", avatar_url: "https://x/a.png" }], milestone: { title: "v1" }, comments: 3 },
    ], 200, { Link: '<https://api.github.com/x?page=3>; rel="next"' })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const result = await client.listIssuesPage("acme", "widgets", {
      state: "open",
      labels: "bug,ui",
      assignee: "octocat",
      milestone: 4,
      sort: "updated",
      direction: "asc",
      page: 2,
      perPage: 10,
    });

    const url = String(fetchImpl.mock.calls[0][0]);
    expect(url).toContain("/repos/acme/widgets/issues?");
    expect(url).toContain("state=open");
    expect(url).toContain("labels=bug%2Cui");
    expect(url).toContain("assignee=octocat");
    expect(url).toContain("milestone=4");
    expect(url).toContain("sort=updated");
    expect(url).toContain("direction=asc");
    expect(url).toContain("page=2");
    expect(url).toContain("per_page=10");

    expect(result.page).toBe(2);
    expect(result.hasNextPage).toBe(true);
    expect(result.nextPage).toBe(3);
    expect(result.items).toEqual([{
      number: 1,
      title: "Issue 1",
      state: "open",
      htmlUrl: "https://github.com/acme/widgets/issues/1",
      labels: [{ name: "bug", color: "red" }],
      assignees: [{ login: "octocat", avatarUrl: "https://x/a.png" }],
      milestoneTitle: "v1",
      commentsCount: 3,
      createdAt: undefined,
      updatedAt: undefined,
    }]);
  });

  it("derives hasNextPage: false when no Link rel=next header is present", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([
      { number: 1, title: "Only", state: "open", html_url: "https://github.com/acme/widgets/issues/1", labels: [] },
    ])) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const result = await client.listIssuesPage("acme", "widgets");

    expect(result.hasNextPage).toBe(false);
    expect(result.nextPage).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("filters out pull-request-shaped results", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([
      { number: 1, title: "Real issue", state: "open", html_url: "https://github.com/acme/widgets/issues/1", labels: [] },
      { number: 2, title: "A PR", state: "open", html_url: "https://github.com/acme/widgets/pull/2", labels: [], pull_request: { url: "..." } },
    ])) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const result = await client.listIssuesPage("acme", "widgets");

    expect(result.items).toHaveLength(1);
    expect(result.items[0].number).toBe(1);
  });

  it("never accumulates multiple pages internally (exactly one fetch per call)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(
      Array.from({ length: 100 }, (_, i) => ({ number: i + 1, title: `Issue ${i + 1}`, state: "open", html_url: "https://x", labels: [] })),
      200,
      { Link: '<https://api.github.com/x?page=2>; rel="next"' },
    )) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const result = await client.listIssuesPage("acme", "widgets", { perPage: 100 });

    expect(result.items).toHaveLength(100);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("GitHubClient.searchIssues (FUSI-012)", () => {
  it("builds the correct q qualifier string, quoting values with spaces", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ total_count: 1, incomplete_results: false, items: [] })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    await client.searchIssues("acme", "widgets", {
      q: "crash on load",
      state: "open",
      labels: ["bug", "needs triage"],
      assignee: "octocat",
      milestone: "v1 release",
      sort: "comments",
      order: "asc",
      page: 1,
      perPage: 30,
    });

    const url = String(fetchImpl.mock.calls[0][0]);
    const q = new URL(url).searchParams.get("q");
    expect(q).toBe('repo:acme/widgets is:issue state:open label:bug label:"needs triage" assignee:octocat milestone:"v1 release" crash on load');
    expect(url).toContain("sort=comments");
    expect(url).toContain("order=asc");
  });

  it("sets cappedAtLimit true once totalCount exceeds 1000", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ total_count: 1500, incomplete_results: false, items: [] })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const result = await client.searchIssues("acme", "widgets", { q: "bug" });

    expect(result.totalCount).toBe(1500);
    expect(result.cappedAtLimit).toBe(true);
  });

  it("sets cappedAtLimit true once page*perPage reaches the 1000 window even if totalCount is under 1000", async () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ number: i + 1, title: `Issue ${i + 1}`, state: "open", html_url: "https://x", labels: [] }));
    const fetchImpl = vi.fn(async () => jsonResponse({ total_count: 950, incomplete_results: false, items })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const result = await client.searchIssues("acme", "widgets", { q: "bug", page: 10, perPage: 100 });

    expect(result.cappedAtLimit).toBe(true);
    expect(result.hasNextPage).toBe(false);
  });

  it("does not set cappedAtLimit under the 1000 boundary", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ total_count: 500, incomplete_results: false, items: [] })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const result = await client.searchIssues("acme", "widgets", { q: "bug" });

    expect(result.cappedAtLimit).toBe(false);
  });

  it("maps items into the shared GitHubIssueSummary shape, filters PRs, and surfaces incompleteResults", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      total_count: 2,
      incomplete_results: true,
      items: [
        { number: 1, title: "Real", state: "open", html_url: "https://x/1", labels: ["bug"], assignees: [], comments: 2 },
        { number: 2, title: "PR", state: "open", html_url: "https://x/2", labels: [], pull_request: { url: "..." } },
      ],
    })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const result = await client.searchIssues("acme", "widgets", { q: "bug" });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ number: 1, commentsCount: 2, labels: [{ name: "bug", color: "ededed" }] });
    expect(result.incompleteResults).toBe(true);
  });

  it("maps errors through GitHubApiError and never leaks the token", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "Bad credentials secret-tok" }, 401)) as unknown as typeof fetch;
    const client = new GitHubClient("secret-tok", fetchImpl);

    await expect(client.searchIssues("acme", "widgets", { q: "bug" })).rejects.toMatchObject({ status: 401, code: "auth_error" });
    await client.searchIssues("acme", "widgets", { q: "bug" }).catch((error) => {
      expect(String(error.message)).not.toContain("secret-tok");
    });
  });
});

describe("GitHubClient.listMilestones (FUSI-012)", () => {
  it("maps milestone fields correctly, including the KB-003 additive progress/due-date fields", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([
      { number: 1, title: "v1", state: "open", open_issues: 3, closed_issues: 1, due_on: "2026-08-01T00:00:00Z", html_url: "https://x/1", extraneous: true },
      { number: 2, title: "v2", state: "closed", open_issues: 0, closed_issues: 5 },
    ])) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const milestones = await client.listMilestones("acme", "widgets");

    // FNXC:GithubPmMilestones 2026-07-25-00:20: the original number/title/state fields the
    // issues-filter-dropdown consumer relies on stay unchanged; new fields are additive.
    expect(milestones[0]).toMatchObject({ number: 1, title: "v1", state: "open", openIssues: 3, closedIssues: 1, dueOn: "2026-08-01T00:00:00Z", htmlUrl: "https://x/1" });
    expect(milestones[1]).toMatchObject({ number: 2, title: "v2", state: "closed", openIssues: 0, closedIssues: 5, dueOn: null });
    const url = String(fetchImpl.mock.calls[0][0]);
    expect(url).toContain("/repos/acme/widgets/milestones");
    expect(url).toContain("state=all");
  });

  it("defaults open/closed issue counts to 0 when GitHub omits them (never NaN)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([{ number: 3, title: "v3", state: "open" }])) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const milestones = await client.listMilestones("acme", "widgets");

    expect(milestones[0]).toMatchObject({ openIssues: 0, closedIssues: 0 });
  });

  it("accepts a state filter option", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([])) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    await client.listMilestones("acme", "widgets", { state: "open" });

    const url = String(fetchImpl.mock.calls[0][0]);
    expect(url).toContain("state=open");
  });
});

describe("GitHubClient milestone writes (KB-003)", () => {
  it("createMilestone round-trips GitHub's authoritative created milestone", async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({ title: "v3", due_on: "2026-09-01T00:00:00Z" });
      return jsonResponse({ number: 3, title: "v3", state: "open", open_issues: 0, closed_issues: 0, due_on: "2026-09-01T00:00:00Z" });
    }) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const milestone = await client.createMilestone("acme", "widgets", { title: "v3", dueOn: "2026-09-01T00:00:00Z" });

    expect(milestone).toMatchObject({ number: 3, title: "v3", state: "open", openIssues: 0, closedIssues: 0 });
  });

  it("updateMilestone round-trips and can clear the due date with dueOn:null", async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({ due_on: null });
      return jsonResponse({ number: 3, title: "v3", state: "open", open_issues: 1, closed_issues: 2, due_on: null });
    }) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const milestone = await client.updateMilestone("acme", "widgets", 3, { dueOn: null });

    expect(milestone).toMatchObject({ number: 3, dueOn: null });
  });

  it("setMilestoneState closes a milestone via PATCH state", async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      expect(JSON.parse(String((init as RequestInit).body))).toEqual({ state: "closed" });
      return jsonResponse({ number: 3, title: "v3", state: "closed", open_issues: 0, closed_issues: 2, closed_at: "2026-07-25T00:00:00Z" });
    }) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const milestone = await client.setMilestoneState("acme", "widgets", 3, { state: "closed" });

    expect(milestone).toMatchObject({ state: "closed", closedAt: "2026-07-25T00:00:00Z" });
  });

  it("deleteMilestone tolerates a 204 with no response body", async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      expect(init?.method).toBe("DELETE");
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    await expect(client.deleteMilestone("acme", "widgets", 3)).resolves.toBeUndefined();
  });

  it("listOpenIssuesForMilestone paginates and drops pull requests", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return jsonResponse(
          [
            { number: 1, title: "Bug", state: "open", html_url: "https://x/1" },
            { number: 2, title: "A PR", state: "open", html_url: "https://x/2", pull_request: {} },
          ],
          200,
          { Link: '<https://api.github.com/repos/acme/widgets/issues?milestone=3&state=open&page=2>; rel="next"' },
        );
      }
      return jsonResponse([{ number: 3, title: "Feature", state: "open", html_url: "https://x/3" }]);
    }) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const items = await client.listOpenIssuesForMilestone("acme", "widgets", 3, 50);

    expect(items.map((issue) => issue.number)).toEqual([1, 3]);
    const firstUrl = String(fetchImpl.mock.calls[0][0]);
    expect(firstUrl).toContain("milestone=3");
    expect(firstUrl).toContain("state=open");
  });

  it("setIssueMilestone PATCHes the issue's milestone field, including clearing with null", async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(String((init as RequestInit).body))).toEqual({ milestone: null });
      return jsonResponse({ number: 7, title: "X", state: "open", html_url: "https://x", milestone: null });
    }) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const issue = await client.setIssueMilestone("acme", "widgets", 7, null);

    expect(issue.milestone).toBeNull();
  });
});

describe("GitHubClient token scopes", () => {
  it("reports project scope presence from x-oauth-scopes", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 200, { "x-oauth-scopes": "repo, read:org, project" })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const scopes = await client.getTokenScopes();

    expect(scopes.scopes).toEqual(["repo", "read:org", "project"]);
    expect(scopes.hasScope("project")).toBe(true);
    expect(scopes.hasScope("admin:org")).toBe(false);
  });

  it("reports missing project scope", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 200, { "x-oauth-scopes": "repo" })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const scopes = await client.getTokenScopes();

    expect(scopes.hasScope("project")).toBe(false);
  });

  it("handles a missing x-oauth-scopes header (fine-grained PAT)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const scopes = await client.getTokenScopes();

    expect(scopes.scopes).toEqual([]);
    expect(scopes.hasScope("project")).toBe(false);
  });
});

/*
FNXC:GithubPmIssues 2026-07-24-05:00:
FUSI-014 write-method tests: each asserts the exact method+URL+body issued (via `writeJson`,
exercised for the first time here), the GitHub response mapped back into the expected
camelCase shape, and that error classification (403 -> auth_error, 404 -> not_found) and
token redaction are inherited from `fetchThrottled` unchanged -- no write method reimplements
any of that.
*/
describe("GitHubClient.createIssue (FUSI-014)", () => {
  it("POSTs the correct URL/body and maps the created issue", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      number: 42, title: "New issue", state: "open", body: "Details", html_url: "https://github.com/acme/widgets/issues/42",
      user: { login: "octocat" }, labels: [{ name: "bug", color: "red" }], assignees: [{ login: "octocat" }],
      milestone: { title: "v1", state: "open" }, comments: 0,
    })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const issue = await client.createIssue("acme", "widgets", { title: "New issue", body: "Details", labels: ["bug"], assignees: ["octocat"], milestone: 1 });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://api.github.com/repos/acme/widgets/issues");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ title: "New issue", body: "Details", labels: ["bug"], assignees: ["octocat"], milestone: 1 });
    expect(issue).toMatchObject({ number: 42, title: "New issue", state: "open", bodyMarkdown: "Details" });
  });

  it("omits optional fields from the body when not supplied", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ number: 1, title: "Bare", state: "open", html_url: "https://x" })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    await client.createIssue("acme", "widgets", { title: "Bare" });

    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ title: "Bare" });
  });

  it("maps a 403 to auth_error and never leaks the token", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "Resource not accessible by integration" }, 403)) as unknown as typeof fetch;
    const client = new GitHubClient("secret-tok", fetchImpl);

    await expect(client.createIssue("acme", "widgets", { title: "X" })).rejects.toMatchObject({ status: 403, code: "auth_error" });
    await client.createIssue("acme", "widgets", { title: "X" }).catch((error) => {
      expect(String(error.message)).not.toContain("secret-tok");
    });
  });
});

describe("GitHubClient.updateIssue (FUSI-014)", () => {
  it("PATCHes title/body and maps the updated issue", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ number: 5, title: "Edited", state: "open", body: "New body", html_url: "https://x" })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const issue = await client.updateIssue("acme", "widgets", 5, { title: "Edited", body: "New body" });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://api.github.com/repos/acme/widgets/issues/5");
    expect((init as RequestInit).method).toBe("PATCH");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ title: "Edited", body: "New body" });
    expect(issue).toMatchObject({ number: 5, title: "Edited", bodyMarkdown: "New body" });
  });

  it("maps a 404 to not_found", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "Not Found" }, 404)) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);
    await expect(client.updateIssue("acme", "ghost", 999, { title: "X" })).rejects.toMatchObject({ status: 404, code: "not_found" });
  });
});

describe("GitHubClient.setIssueState (FUSI-014)", () => {
  it("closes with a state_reason", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ number: 5, title: "X", state: "closed", state_reason: "completed", html_url: "https://x" })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const issue = await client.setIssueState("acme", "widgets", 5, { state: "closed", stateReason: "completed" });

    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ state: "closed", state_reason: "completed" });
    expect(issue.state).toBe("closed");
  });

  it("reopens without forcing a state_reason", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ number: 5, title: "X", state: "open", html_url: "https://x" })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const issue = await client.setIssueState("acme", "widgets", 5, { state: "open" });

    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ state: "open" });
    expect(issue.state).toBe("open");
  });
});

describe("GitHubClient comment writes (FUSI-014)", () => {
  it("createIssueComment POSTs to the issue's comments endpoint", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 99, user: { login: "octocat" }, body: "Hello", created_at: "2026-01-01T00:00:00Z" })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const comment = await client.createIssueComment("acme", "widgets", 5, "Hello");

    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://api.github.com/repos/acme/widgets/issues/5/comments");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ body: "Hello" });
    expect(comment).toMatchObject({ id: 99, bodyMarkdown: "Hello", author: { login: "octocat" } });
  });

  it("updateIssueComment PATCHes the comment-id endpoint (not issue-number-keyed)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 99, user: { login: "octocat" }, body: "Edited" })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const comment = await client.updateIssueComment("acme", "widgets", 99, "Edited");

    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://api.github.com/repos/acme/widgets/issues/comments/99");
    expect((init as RequestInit).method).toBe("PATCH");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ body: "Edited" });
    expect(comment.bodyMarkdown).toBe("Edited");
  });

  it("maps errors and never leaks the token in comment writes", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "Bad credentials secret-tok" }, 401)) as unknown as typeof fetch;
    const client = new GitHubClient("secret-tok", fetchImpl);
    await expect(client.createIssueComment("acme", "widgets", 5, "Hi")).rejects.toMatchObject({ status: 401, code: "auth_error" });
  });
});

describe("GitHubClient.getRepositoryFeatures (FUSI-009)", () => {
  it("parses hasIssuesEnabled/hasDiscussionsEnabled/hasProjectsEnabled/viewerPermission from GraphQL", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: {
          repository: {
            hasIssuesEnabled: true,
            hasDiscussionsEnabled: false,
            hasProjectsEnabled: true,
            viewerPermission: "WRITE",
          },
        },
      }),
    ) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const features = await client.getRepositoryFeatures("acme", "widgets");

    expect(features).toEqual({
      hasIssuesEnabled: true,
      hasDiscussionsEnabled: false,
      hasProjectsEnabled: true,
      viewerPermission: "WRITE",
    });
    expect(fetchImpl).toHaveBeenCalledWith(GITHUB_GRAPHQL_ENDPOINT, expect.objectContaining({ method: "POST" }));
    const body = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body));
    expect(body.variables).toEqual({ owner: "acme", repo: "widgets" });
  });

  it("maps a null repository (no access / not found) to a not_found GitHubApiError, not a bespoke error path", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { repository: null } })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    await expect(client.getRepositoryFeatures("acme", "ghost")).rejects.toMatchObject({ status: 404, code: "not_found" });
  });

  it("issues exactly one GraphQL request (single cheap read, no per-tab probes)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: { repository: { hasIssuesEnabled: true, hasDiscussionsEnabled: true, hasProjectsEnabled: true, viewerPermission: "ADMIN" } } }),
    ) as unknown as typeof fetch;
    const client = new GitHubClient("secret-tok", fetchImpl);

    await client.getRepositoryFeatures("acme", "widgets");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

/*
FNXC:GithubPmLabels 2026-07-24-10:10:
KB-002 label CRUD + usage-count client method tests. Mirrors the FUSI-014 write-method test
shape above: exact method+URL+body assertions, authoritative-object mapping, error
classification inheritance, and token-redaction. Every test injects a mocked fetch; none
touches api.github.com.
*/
describe("normalizeGitHubLabelColor (KB-002)", () => {
  it("strips a leading # and lowercases", () => {
    expect(normalizeGitHubLabelColor("#D73A4A")).toBe("d73a4a");
    expect(normalizeGitHubLabelColor("d73a4a")).toBe("d73a4a");
  });

  it("rejects invalid colors", () => {
    expect(normalizeGitHubLabelColor("red")).toBeNull();
    expect(normalizeGitHubLabelColor("#d73a4")).toBeNull();
    expect(normalizeGitHubLabelColor("#d73a4az")).toBeNull();
    expect(normalizeGitHubLabelColor("")).toBeNull();
  });
});

describe("GitHubClient.listLabelsRest (KB-002)", () => {
  it("GETs the REST labels endpoint and maps name/color/description", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([{ name: "bug", color: "d73a4a", description: "Something isn't working" }, { name: "docs", color: "0075ca", description: null }]),
    ) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const labels = await client.listLabelsRest("acme", "widgets");

    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://api.github.com/repos/acme/widgets/labels?per_page=100");
    expect(labels).toEqual([
      { name: "bug", color: "d73a4a", description: "Something isn't working" },
      { name: "docs", color: "0075ca", description: null },
    ]);
  });
});

describe("GitHubClient.getLabelUsageCount (KB-002)", () => {
  it("issues the correct search query and returns total_count", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ total_count: 3, items: [] })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const count = await client.getLabelUsageCount("acme", "widgets", "bug");

    const url = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(url.pathname).toBe("/search/issues");
    expect(url.searchParams.get("q")).toBe('repo:acme/widgets is:issue is:open label:bug');
    expect(url.searchParams.get("per_page")).toBe("1");
    expect(count).toBe(3);
  });

  it("quotes a label name containing whitespace", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ total_count: 0, items: [] })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    await client.getLabelUsageCount("acme", "widgets", "good first issue");

    const url = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(url.searchParams.get("q")).toBe('repo:acme/widgets is:issue is:open label:"good first issue"');
  });
});

describe("GitHubClient.createLabel (KB-002)", () => {
  it("POSTs name/color/description and returns the authoritative created label", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ name: "bug", color: "d73a4a", description: "desc" })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const label = await client.createLabel("acme", "widgets", { name: "bug", color: "#D73A4A", description: "desc" });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://api.github.com/repos/acme/widgets/labels");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ name: "bug", color: "d73a4a", description: "desc" });
    expect(label).toEqual({ name: "bug", color: "d73a4a", description: "desc" });
  });

  it("rejects an invalid color before issuing any request", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    await expect(client.createLabel("acme", "widgets", { name: "bug", color: "not-a-color" })).rejects.toMatchObject({ status: 400, code: "invalid_color" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps a 422 duplicate-name response via the inherited classifier", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "Validation Failed" }, 422)) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    await expect(client.createLabel("acme", "widgets", { name: "bug", color: "d73a4a" })).rejects.toMatchObject({ status: 422, code: "github_api_error" });
  });

  it("maps a 403 to auth_error and never leaks the token", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "Resource not accessible by integration" }, 403)) as unknown as typeof fetch;
    const client = new GitHubClient("secret-tok", fetchImpl);

    await expect(client.createLabel("acme", "widgets", { name: "bug", color: "d73a4a" })).rejects.toMatchObject({ status: 403, code: "auth_error" });
  });
});

describe("GitHubClient.updateLabel (KB-002)", () => {
  it("sends new_name on rename (never delete+recreate)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ name: "bug-report", color: "d73a4a", description: "desc" })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const label = await client.updateLabel("acme", "widgets", "bug", { newName: "bug-report" });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://api.github.com/repos/acme/widgets/labels/bug");
    expect((init as RequestInit).method).toBe("PATCH");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ new_name: "bug-report" });
    expect(label.name).toBe("bug-report");
  });

  it("recolors and re-describes without a rename", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ name: "bug", color: "0075ca", description: "new desc" })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    await client.updateLabel("acme", "widgets", "bug", { color: "#0075CA", description: "new desc" });

    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ color: "0075ca", description: "new desc" });
  });

  it("rejects an invalid color before issuing any request", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    await expect(client.updateLabel("acme", "widgets", "bug", { color: "zzzzzz" })).rejects.toMatchObject({ status: 400, code: "invalid_color" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps a 404 to not_found (unknown label)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "Not Found" }, 404)) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    await expect(client.updateLabel("acme", "widgets", "ghost", { color: "d73a4a" })).rejects.toMatchObject({ status: 404, code: "not_found" });
  });
});

describe("GitHubClient.deleteLabel (KB-002)", () => {
  it("DELETEs the label endpoint and tolerates a 204 empty body", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const result = await client.deleteLabel("acme", "widgets", "bug");

    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://api.github.com/repos/acme/widgets/labels/bug");
    expect((init as RequestInit).method).toBe("DELETE");
    expect(result).toEqual({ deleted: true });
  });

  it("maps a 404 to not_found (unknown label)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "Not Found" }, 404)) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    await expect(client.deleteLabel("acme", "widgets", "ghost")).rejects.toMatchObject({ status: 404, code: "not_found" });
  });

  it("maps a 403 to auth_error and never leaks the token", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "Resource not accessible by integration" }, 403)) as unknown as typeof fetch;
    const client = new GitHubClient("secret-tok", fetchImpl);

    await expect(client.deleteLabel("acme", "widgets", "bug")).rejects.toMatchObject({ status: 403, code: "auth_error" });
  });
});

/*
FNXC:GithubPmDiscussions 2026-07-25-13:40:
KB-006 tests: detail two-level nesting, comment/reply cursor pagination to exhaustion,
GraphQL-error mapping on detail, and the add-discussion-comment parent-linkage contract
(top-level post sends NO replyToId; a reply sends the exact parent id; the returned
replyToId matches the requested parent).
*/
function discussionDetailNode(overrides: Record<string, unknown> = {}) {
  return {
    id: "D_kwDOA1",
    number: 7,
    title: "How do I configure X?",
    url: "https://github.com/acme/widgets/discussions/7",
    body: "Please help.",
    upvoteCount: 3,
    author: { login: "octocat", avatarUrl: "https://a" },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    answerChosenAt: null,
    category: { name: "Q&A", emoji: "?", isAnswerable: true },
    comments: {
      totalCount: 1,
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [
        {
          id: "DC_1",
          body: "Try this.",
          upvoteCount: 2,
          author: { login: "helper" },
          createdAt: "2026-01-01T01:00:00Z",
          replies: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ id: "DR_1", body: "Thanks!", upvoteCount: 1, author: { login: "octocat" }, createdAt: "2026-01-01T02:00:00Z" }],
          },
        },
      ],
    },
    ...overrides,
  };
}

describe("GitHubClient.getDiscussionDetail (KB-006)", () => {
  it("maps a two-level thread (comments each with their own replies), upvote counts, and a null answerChosenAt", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { repository: { discussion: discussionDetailNode() } } })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const detail = await client.getDiscussionDetail("acme", "widgets", 7);

    expect(detail).not.toBeNull();
    expect(detail?.id).toBe("D_kwDOA1");
    expect(detail?.upvoteCount).toBe(3);
    expect(detail?.answerChosenAt).toBeNull();
    expect(detail?.categoryName).toBe("Q&A");
    expect(detail?.isAnswerable).toBe(true);
    expect(detail?.comments).toHaveLength(1);
    expect(detail?.comments[0].id).toBe("DC_1");
    expect(detail?.comments[0].upvoteCount).toBe(2);
    expect(detail?.comments[0].replies).toHaveLength(1);
    expect(detail?.comments[0].replies[0].id).toBe("DR_1");
    expect(detail?.comments[0].repliesNextCursor).toBeNull();
    expect(detail?.commentsNextCursor).toBeNull();
  });

  it("maps a present answerChosenAt without crashing (Q&A discussion with a chosen answer)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      data: { repository: { discussion: discussionDetailNode({ answerChosenAt: "2026-01-03T00:00:00Z" }) } },
    })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const detail = await client.getDiscussionDetail("acme", "widgets", 7);
    expect(detail?.answerChosenAt).toBe("2026-01-03T00:00:00Z");
  });

  it("returns null when the repository resolves but the discussion does not", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { repository: { discussion: null } } })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const detail = await client.getDiscussionDetail("acme", "widgets", 999);
    expect(detail).toBeNull();
  });

  it("maps a GraphQL errors[] payload to a thrown graphql_error (detail surfaces the error rather than degrading)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ errors: [{ message: "Discussions are disabled for this repository" }] })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    await expect(client.getDiscussionDetail("acme", "widgets", 7)).rejects.toMatchObject({ code: "graphql_error" });
  });
});

describe("GitHubClient.listDiscussionComments (KB-006)", () => {
  it("follows pageInfo.endCursor across pages to exhaustion", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        data: {
          repository: {
            discussion: {
              comments: {
                pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
                nodes: [{ id: "DC_2", body: "page one", upvoteCount: 0, author: { login: "a" }, createdAt: "2026-01-01T00:00:00Z", replies: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } }],
              },
            },
          },
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        data: {
          repository: {
            discussion: {
              comments: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ id: "DC_3", body: "page two", upvoteCount: 0, author: { login: "b" }, createdAt: "2026-01-01T00:00:00Z", replies: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } }],
              },
            },
          },
        },
      }));
    const client = new GitHubClient("token", fetchImpl as unknown as typeof fetch);

    const pageOne = await client.listDiscussionComments("acme", "widgets", 7);
    expect(pageOne.comments.map((c) => c.id)).toEqual(["DC_2"]);
    expect(pageOne.nextCursor).toBe("cursor-1");

    const pageTwo = await client.listDiscussionComments("acme", "widgets", 7, { after: pageOne.nextCursor! });
    expect(pageTwo.comments.map((c) => c.id)).toEqual(["DC_3"]);
    expect(pageTwo.nextCursor).toBeNull();

    const [, secondInit] = fetchImpl.mock.calls[1];
    expect(JSON.parse((secondInit as RequestInit).body as string).variables.after).toBe("cursor-1");
  });

  it("defensively maps a missing comments connection to an empty page (no throw)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { repository: { discussion: null } } })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const page = await client.listDiscussionComments("acme", "widgets", 7);
    expect(page).toEqual({ comments: [], nextCursor: null });
  });
});

describe("GitHubClient.listDiscussionCommentReplies (KB-006)", () => {
  it("follows pageInfo.endCursor across pages to exhaustion, addressed by comment node id", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        data: { node: { replies: { pageInfo: { hasNextPage: true, endCursor: "reply-cursor-1" }, nodes: [{ id: "DR_2", body: "r1", upvoteCount: 0, author: { login: "a" }, createdAt: "2026-01-01T00:00:00Z" }] } } },
      }))
      .mockResolvedValueOnce(jsonResponse({
        data: { node: { replies: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "DR_3", body: "r2", upvoteCount: 0, author: { login: "b" }, createdAt: "2026-01-01T00:00:00Z" }] } } },
      }));
    const client = new GitHubClient("token", fetchImpl as unknown as typeof fetch);

    const pageOne = await client.listDiscussionCommentReplies("DC_1");
    expect(pageOne.replies.map((r) => r.id)).toEqual(["DR_2"]);
    expect(pageOne.nextCursor).toBe("reply-cursor-1");

    const pageTwo = await client.listDiscussionCommentReplies("DC_1", { after: pageOne.nextCursor! });
    expect(pageTwo.replies.map((r) => r.id)).toEqual(["DR_3"]);
    expect(pageTwo.nextCursor).toBeNull();

    const [firstUrl, firstInit] = fetchImpl.mock.calls[0];
    expect(String(firstUrl)).toBe(GITHUB_GRAPHQL_ENDPOINT);
    expect(JSON.parse((firstInit as RequestInit).body as string).variables.commentId).toBe("DC_1");
  });
});

describe("GitHubClient.addDiscussionComment (KB-006 parent-linkage invariant)", () => {
  it("sends NO replyToId for a top-level comment post", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      data: { addDiscussionComment: { comment: { id: "DC_9", body: "top level", upvoteCount: 0, author: { login: "octocat" }, createdAt: "2026-01-01T00:00:00Z", replyTo: null } } },
    })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const comment = await client.addDiscussionComment({ discussionId: "D_1", body: "top level" });

    const [, init] = fetchImpl.mock.calls[0];
    const sentVariables = JSON.parse((init as RequestInit).body as string).variables;
    expect(sentVariables.input).toEqual({ discussionId: "D_1", body: "top level" });
    expect(Object.prototype.hasOwnProperty.call(sentVariables.input, "replyToId")).toBe(false);
    expect(comment.replyToId).toBeNull();
  });

  it("sends the exact parent id for a reply, and the returned replyToId matches the requested parent", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      data: { addDiscussionComment: { comment: { id: "DC_10", body: "a reply", upvoteCount: 0, author: { login: "octocat" }, createdAt: "2026-01-01T00:00:00Z", replyTo: { id: "DC_1" } } } },
    })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    const comment = await client.addDiscussionComment({ discussionId: "D_1", body: "a reply", replyToId: "DC_1" });

    const [, init] = fetchImpl.mock.calls[0];
    const sentVariables = JSON.parse((init as RequestInit).body as string).variables;
    expect(sentVariables.input).toEqual({ discussionId: "D_1", body: "a reply", replyToId: "DC_1" });
    expect(comment.replyToId).toBe("DC_1");
  });

  it("throws a graphql_error when the mutation payload omits the created comment", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { addDiscussionComment: { comment: null } } })) as unknown as typeof fetch;
    const client = new GitHubClient("token", fetchImpl);

    await expect(client.addDiscussionComment({ discussionId: "D_1", body: "x" })).rejects.toMatchObject({ code: "graphql_error" });
  });
});


