import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GITHUB_GRAPHQL_ENDPOINT,
  GITHUB_REST_BASE_URL,
  GitHubApiError,
  GitHubClient,
  githubErrorToResponse,
  isGitHubApiError,
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
