/*
FNXC:GitHubPmClient 2026-07-24-00:00:
FUSI-003 gives the GitHub PM plugin its own portable GitHub API client (REST + GraphQL),
patterned on packages/dashboard/src/github.ts (fetchThrottled/buildHeaders/pagination) and
plugins/fusion-plugin-linear-import/src/linear-client.ts (injectable fetchImpl, typed error
class, credential-safe redaction). It is deliberately token-only `fetch` -- no gh-CLI shellout
and no @fusion/core dependency in the hot path -- so the module stays portable for eventual
upstream submission. Domain methods beyond one REST list + one GraphQL list are out of scope;
later FUSI-* slices (issues core, labels/milestones, Projects v2, discussions) build on top.
*/

export const GITHUB_REST_BASE_URL = "https://api.github.com";
export const GITHUB_GRAPHQL_ENDPOINT = "https://api.github.com/graphql";
export const GITHUB_API_VERSION = "2022-11-28";

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;
const REST_PAGE_SIZE = 100;
const GRAPHQL_PAGE_SIZE = 50;
const GRAPHQL_MAX_PAGES = 10;

/** Discriminated error codes callers can branch on without inspecting message text. */
export type GitHubApiErrorCode =
  | "auth_error"
  | "not_found"
  | "rate_limited"
  | "graphql_error"
  | "network_error"
  | "github_api_error";

/**
 * FNXC:GitHubPmClient 2026-07-24-00:00:
 * Mirrors LinearApiError's shape (status + discriminated code) so plugin routes/tools can
 * map failures consistently across both SaaS integrations. `status` is 0 for network errors
 * (mapped to HTTP 502 by githubErrorToResponse, matching linearErrorToResponse's convention).
 */
export class GitHubApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: GitHubApiErrorCode = "github_api_error",
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export function isGitHubApiError(error: unknown): error is GitHubApiError {
  return error instanceof GitHubApiError;
}

/** Maps a thrown error to an HTTP-response-shaped object for plugin routes to return directly. */
export function githubErrorToResponse(error: unknown): { status: number; error: string; code: string } {
  if (isGitHubApiError(error)) {
    const status = error.status === 0 ? 502 : error.status;
    return { status, error: error.message, code: error.code };
  }
  return { status: 500, error: "GitHub request failed unexpectedly.", code: "unexpected_error" };
}

/**
 * FNXC:GitHubPmClient 2026-07-24-00:00:
 * Credential-safe redaction mirroring linear-client's redactSensitiveText. Every thrown
 * GitHubApiError message is passed through this so the token can never leak into logs,
 * error banners, or downstream tool output.
 */
export function redactSensitiveText(message: string, secrets: string[] = []): string {
  let redacted = message;
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted.replace(/\b(token|key|secret)[-_:=][A-Za-z0-9._-]+/giu, "$1-[redacted]");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitedResponse(response: Response): boolean {
  if (response.status === 429) return true;
  if (response.status !== 403) return false;
  // GitHub secondary/primary rate limits signal via these headers even on 403; a plain
  // permission-denied 403 (no scope) carries neither, so we classify that as auth_error instead.
  const remaining = response.headers.get("x-ratelimit-remaining");
  const retryAfter = response.headers.get("Retry-After");
  return remaining === "0" || retryAfter !== null;
}

function retryDelayMsFor(response: Response, fallbackMs: number): number {
  const retryAfter = response.headers.get("Retry-After");
  if (retryAfter) {
    const seconds = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  }
  const reset = response.headers.get("x-ratelimit-reset");
  if (reset) {
    const resetEpochSeconds = Number.parseInt(reset, 10);
    if (Number.isFinite(resetEpochSeconds)) {
      const ms = resetEpochSeconds * 1000 - Date.now();
      if (ms > 0) return ms;
    }
  }
  return fallbackMs;
}

async function readErrorMessage(response: Response, secrets: string[]): Promise<string> {
  const body = await response.json().catch(() => undefined) as { message?: unknown } | undefined;
  const raw = typeof body?.message === "string" && body.message.trim() ? body.message.trim() : undefined;
  return redactSensitiveText(raw ?? `GitHub API request failed with status ${response.status}.`, secrets);
}

export interface GitHubClientOptions {
  /** Maximum retry attempts on a rate-limited (403/429) response before throwing. Default 3. */
  maxRetries?: number;
  /** Base backoff delay in ms when neither Retry-After nor x-ratelimit-reset is present. Default 1000. */
  retryDelayMs?: number;
}

export interface GitHubListPage<T> {
  items: T[];
  /** Present when the REST Link header advertised a `rel="next"` page. */
  nextUrl?: string;
}

export interface GitHubPageInfo {
  hasNextPage: boolean;
  endCursor?: string | null;
}

export interface GitHubGraphQlConnection<T> {
  nodes: T[];
  pageInfo: GitHubPageInfo;
}

export interface GitHubIssueListOptions {
  state?: "open" | "closed" | "all";
  labels?: string;
  /** Bounds total items returned across all pages. Default: a single page (100). */
  maxItems?: number;
}

export interface GitHubIssueListItem {
  number: number;
  title: string;
  state: string;
  htmlUrl: string;
  labels: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface GitHubLabelListOptions {
  /** Bounds total items returned across all GraphQL pages. Default: a single page. */
  maxItems?: number;
}

export interface GitHubLabel {
  id: string;
  name: string;
  color: string;
  description?: string | null;
}

export interface GitHubTokenScopes {
  scopes: string[];
  hasScope: (scope: string) => boolean;
}

export interface GitHubDiscussionListOptions {
  /** Bounds total items returned across all GraphQL pages. Default: a single page. */
  maxItems?: number;
}

/**
 * FNXC:GitHubPmClient 2026-07-24-00:00:
 * FUSI-005 read-only discussion-history input for the taxonomy generator. Mirrors
 * GitHubIssueListItem's shape closely enough for the taxonomy aggregator to treat
 * issues and discussions uniformly. `category` folds the discussion's category name
 * into the same query (per the task's "fold discussion categories into the same
 * query" instruction) so no second round-trip is needed to learn a repo's discussion
 * taxonomy.
 */
export interface GitHubDiscussionListItem {
  number: number;
  title: string;
  category: string | null;
  createdAt?: string;
}

/**
 * FNXC:GitHubPmClient 2026-07-24-00:00:
 * Portable, plugin-owned GitHub API client. Constructor takes a token (may be undefined for
 * unauthenticated read-only calls against public repos) and an injectable fetch implementation
 * so unit tests never touch the real network. All REST calls go through `fetchThrottled`, which
 * classifies non-OK responses into a discriminated GitHubApiError and backs off on rate limits.
 */
export class GitHubClient {
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(
    private readonly token: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
    options: GitHubClientOptions = {},
  ) {
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  }

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      ...extra,
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }

  private secrets(): string[] {
    return this.token ? [this.token] : [];
  }

  /**
   * Rate-limit-aware throttled fetch: retries up to `maxRetries` on 403/429 responses that
   * carry rate-limit signals, honoring Retry-After / x-ratelimit-reset for the backoff
   * interval; other non-OK statuses are mapped to a typed GitHubApiError and NOT retried.
   */
  async fetchThrottled(url: string, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          ...init,
          headers: { ...this.buildHeaders(), ...(init.headers as Record<string, string> | undefined) },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new GitHubApiError(0, redactSensitiveText(`Unable to reach GitHub API: ${message}`, this.secrets()), "network_error");
      }

      if (isRateLimitedResponse(response)) {
        if (attempt >= this.maxRetries) {
          throw new GitHubApiError(response.status, "GitHub API rate limit exceeded after retries.", "rate_limited");
        }
        await delay(retryDelayMsFor(response, this.retryDelayMs * 2 ** attempt));
        continue;
      }

      if (response.status === 401) {
        throw new GitHubApiError(401, await readErrorMessage(response, this.secrets()), "auth_error");
      }
      if (response.status === 403) {
        throw new GitHubApiError(403, await readErrorMessage(response, this.secrets()), "auth_error");
      }
      if (response.status === 404) {
        throw new GitHubApiError(404, await readErrorMessage(response, this.secrets()), "not_found");
      }
      if (!response.ok) {
        throw new GitHubApiError(response.status, await readErrorMessage(response, this.secrets()), "github_api_error");
      }

      return response;
    }
    // Unreachable: the loop always returns or throws, but TypeScript needs an exhaustive path.
    throw new GitHubApiError(0, "GitHub request retry loop exited unexpectedly.", "network_error");
  }

  private async requestJson<T>(url: string, init: RequestInit = {}): Promise<{ data: T; response: Response }> {
    const response = await this.fetchThrottled(url, init);
    const data = await response.json() as T;
    return { data, response };
  }

  /**
   * FNXC:GitHubPmClient 2026-07-24-00:00:
   * Generic REST list pagination: follows the `Link` header's `rel="next"` cursor (not a
   * page-number counter) so it works uniformly across any GitHub list endpoint, accumulating
   * until either the server reports no more pages or the caller-supplied `maxItems` is hit.
   */
  private async paginateRest<T>(initialUrl: string, maxItems: number): Promise<T[]> {
    const items: T[] = [];
    let url: string | undefined = initialUrl;
    while (url && items.length < maxItems) {
      const { data, response } = await this.requestJson<T[]>(url);
      const page = Array.isArray(data) ? data : [];
      items.push(...page);
      url = parseNextLinkUrl(response.headers.get("Link"));
      if (page.length === 0) break;
    }
    return items.slice(0, maxItems);
  }

  /**
   * List issues for a repository, paginating across the REST `Link` header when the result
   * set exceeds GitHub's 100-item per-page ceiling. Exercises `paginateRest` end-to-end.
   */
  async listIssues(owner: string, repo: string, options: GitHubIssueListOptions = {}): Promise<GitHubIssueListItem[]> {
    const maxItems = options.maxItems ?? REST_PAGE_SIZE;
    const params = new URLSearchParams({
      state: options.state ?? "open",
      per_page: String(REST_PAGE_SIZE),
    });
    if (options.labels) params.set("labels", options.labels);
    const url = `${GITHUB_REST_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?${params.toString()}`;
    const raw = await this.paginateRest<GitHubRestIssue>(url, maxItems);
    // GitHub's issues endpoint also returns pull requests; filter those out like the host client does.
    return raw
      .filter((issue) => !issue.pull_request)
      .map((issue) => ({
        number: issue.number,
        title: issue.title,
        state: issue.state,
        htmlUrl: issue.html_url,
        labels: (issue.labels ?? []).map((label) => (typeof label === "string" ? label : label.name)).filter((name): name is string => Boolean(name)),
        createdAt: issue.created_at,
        updatedAt: issue.updated_at,
      }));
  }

  /**
   * FNXC:GitHubPmClient 2026-07-24-00:00:
   * GraphQL query/mutation core: posts to the GraphQL endpoint, maps a top-level `errors[]`
   * array to a credential-safe GitHubApiError(code:"graphql_error") mirroring LinearClient's
   * GraphQL error handling, and otherwise returns the typed `data` payload.
   */
  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const { data } = await this.requestJson<{ data?: T; errors?: Array<{ message?: string }> }>(GITHUB_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (data.errors && data.errors.length > 0) {
      const message = data.errors.map((error) => error.message).filter(Boolean).join("; ") || "GitHub GraphQL request failed.";
      throw new GitHubApiError(400, redactSensitiveText(`GitHub GraphQL error: ${message}`, this.secrets()), "graphql_error");
    }
    if (data.data === undefined) {
      throw new GitHubApiError(502, "GitHub GraphQL response was missing a data payload.", "graphql_error");
    }
    return data.data;
  }

  /**
   * Bounded cursor pagination over a GraphQL connection shaped `{ nodes, pageInfo }`. `fetchPage`
   * receives the cursor (undefined for the first page) and must return one page; pagination
   * stops at `hasNextPage: false`, an empty page, or the `GRAPHQL_MAX_PAGES` bound -- whichever
   * comes first -- mirroring LinearClient.listIssues' MAX_PAGES guard.
   */
  private async paginateGraphQl<T>(
    fetchPage: (after: string | undefined) => Promise<GitHubGraphQlConnection<T>>,
    maxItems: number,
  ): Promise<T[]> {
    const items: T[] = [];
    let after: string | undefined;
    for (let page = 0; page < GRAPHQL_MAX_PAGES && items.length < maxItems; page += 1) {
      const connection = await fetchPage(after);
      items.push(...connection.nodes);
      if (!connection.pageInfo.hasNextPage || !connection.pageInfo.endCursor || connection.nodes.length === 0) break;
      after = connection.pageInfo.endCursor;
    }
    return items.slice(0, maxItems);
  }

  /**
   * List repository labels via GraphQL, following `pageInfo.endCursor` across pages. Exercises
   * `paginateGraphQl` end-to-end (the concrete GraphQL-backed cursor-pagination method).
   */
  async listLabels(owner: string, repo: string, options: GitHubLabelListOptions = {}): Promise<GitHubLabel[]> {
    const maxItems = options.maxItems ?? GRAPHQL_PAGE_SIZE;
    return this.paginateGraphQl<GitHubLabel>(async (after) => {
      const data = await this.graphql<{
        repository?: { labels?: { nodes?: Array<{ id: string; name: string; color: string; description?: string | null }>; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } };
      }>(GITHUB_LABELS_QUERY, { owner, repo, first: Math.min(GRAPHQL_PAGE_SIZE, maxItems), after: after ?? null });
      const connection = data.repository?.labels;
      return {
        nodes: connection?.nodes ?? [],
        pageInfo: { hasNextPage: connection?.pageInfo?.hasNextPage === true, endCursor: connection?.pageInfo?.endCursor ?? null },
      };
    }, maxItems);
  }

  /**
   * FNXC:GitHubPmClient 2026-07-24-00:00:
   * FUSI-005: read-only discussion-history input for the taxonomy generator (Step 1).
   * Mirrors `listLabels`'s GraphQL-cursor-pagination shape exactly, folding each
   * discussion's category name into the same query per-node (no second round-trip).
   * Discussions require the `repo`/`public_repo` scope (read:discussion in newer PAT
   * models); when the token lacks it GitHub returns a GraphQL error (mapped by `graphql()`
   * to a typed GitHubApiError with code `graphql_error`, or a REST-shaped `not_found`/
   * `auth_error` for some token types) rather than a hard failure. This method degrades
   * that to an empty array instead of throwing, so a taxonomy generation pass over a repo
   * whose token can't see discussions still succeeds using issues+labels alone ("no
   * discussion data", not "generation impossible").
   */
  async listDiscussions(owner: string, repo: string, options: GitHubDiscussionListOptions = {}): Promise<GitHubDiscussionListItem[]> {
    const maxItems = options.maxItems ?? GRAPHQL_PAGE_SIZE;
    try {
      return await this.paginateGraphQl<GitHubDiscussionListItem>(async (after) => {
        const data = await this.graphql<{
          repository?: {
            discussions?: {
              nodes?: Array<{ number: number; title: string; createdAt?: string; category?: { name?: string } | null }>;
              pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
            };
          };
        }>(GITHUB_DISCUSSIONS_QUERY, { owner, repo, first: Math.min(GRAPHQL_PAGE_SIZE, maxItems), after: after ?? null });
        const connection = data.repository?.discussions;
        const nodes = (connection?.nodes ?? []).map((node) => ({
          number: node.number,
          title: node.title,
          category: typeof node.category?.name === "string" ? node.category.name : null,
          createdAt: node.createdAt,
        }));
        return {
          nodes,
          pageInfo: { hasNextPage: connection?.pageInfo?.hasNextPage === true, endCursor: connection?.pageInfo?.endCursor ?? null },
        };
      }, maxItems);
    } catch (error) {
      if (isGitHubApiError(error) && (error.code === "not_found" || error.code === "auth_error" || error.code === "graphql_error")) {
        return [];
      }
      throw error;
    }
  }

  /**
   * FNXC:GitHubPmClient 2026-07-24-00:00:
   * Reads the `x-oauth-scopes` header from a cheap authenticated REST call so FUSI-002's
   * scope-diagnostics feature (e.g. detecting a missing `project` scope for Projects v2) has a
   * primitive to build on. This module intentionally stops at exposing the header -- the
   * diagnostics UI/logic itself belongs to FUSI-002.
   */
  async getTokenScopes(): Promise<GitHubTokenScopes> {
    const response = await this.fetchThrottled(`${GITHUB_REST_BASE_URL}/user`);
    const header = response.headers.get("x-oauth-scopes") ?? "";
    const scopes = header.split(",").map((scope) => scope.trim()).filter(Boolean);
    return { scopes, hasScope: (scope: string) => scopes.includes(scope) };
  }
}

interface GitHubRestIssue {
  number: number;
  title: string;
  state: string;
  html_url: string;
  labels?: Array<string | { name?: string }>;
  created_at?: string;
  updated_at?: string;
  pull_request?: unknown;
}

const GITHUB_LABELS_QUERY = `query FusionGitHubPmLabels($owner: String!, $repo: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    labels(first: $first, after: $after) {
      nodes { id name color description }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const GITHUB_DISCUSSIONS_QUERY = `query FusionGitHubPmDiscussions($owner: String!, $repo: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    discussions(first: $first, after: $after) {
      nodes { number title createdAt category { name } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

/**
 * Parses a REST `Link` response header for the `rel="next"` URL, per
 * https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api
 * Example: `<https://api.github.com/...&page=2>; rel="next", <...>; rel="last"`
 */
export function parseNextLinkUrl(linkHeader: string | null): string | undefined {
  if (!linkHeader) return undefined;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return undefined;
}
