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
  | "github_api_error"
  /*
  FNXC:GithubPmLabels 2026-07-24-10:00:
  KB-002 label-color validation code. A create/update label call whose color fails the
  6-hex-digit check (see normalizeGitHubLabelColor below) throws THIS BEFORE any GitHub
  request is issued -- an invalid color must never reach GitHub. Routes/tools map it to a
  400 the same way every other GitHubApiError maps through githubErrorToResponse.
  */
  | "invalid_color";

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

/*
FNXC:GithubPmLabels 2026-07-24-10:00:
KB-002 shared color normalizer/validator: strips an optional leading '#', lowercases, and
validates against GitHub's documented 6-hex-digit label color format. Returns null on any
invalid input so callers (createLabel/updateLabel, and the LabelsPanel color picker which
imports this same function) reject an invalid color BEFORE it ever reaches a GitHub request.
*/
const GITHUB_LABEL_COLOR_PATTERN = /^[0-9a-f]{6}$/;

export function normalizeGitHubLabelColor(color: string): string | null {
  const stripped = color.trim().replace(/^#/u, "").toLowerCase();
  return GITHUB_LABEL_COLOR_PATTERN.test(stripped) ? stripped : null;
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

/*
FNXC:GithubPmIssues 2026-07-24-03:00:
FUSI-012 read-only, page-at-a-time issue-list reads: `listIssuesPage` (plain filter/sort REST
issues-list) and `searchIssues` (GitHub Search API, only dispatched when a free-text term is
supplied since the plain issues-list endpoint has no full-text search). Both are deliberately
SEPARATE from `listIssues` above -- that method's accumulate-all contract is depended on
byte-for-byte by `taxonomy-proposal.ts` and must never change. Neither new method accumulates
multiple pages internally: each call returns exactly one page, so a 10k-issue repo never loads
more than one page's worth of rows into the caller. The Search API's hard 1,000-result window
is surfaced via `cappedAtLimit` on `GitHubIssueSearchPage` -- it is never silently truncated.
*/

export interface GitHubIssueListPageOptions {
  state?: "open" | "closed" | "all";
  /** Comma-joined label names, mirroring the REST `labels` query param. */
  labels?: string;
  assignee?: string;
  /** A milestone number, or the literal "none"/"*" per GitHub's REST semantics. */
  milestone?: string | number;
  sort?: "created" | "updated" | "comments";
  direction?: "asc" | "desc";
  /** 1-based page number. Default 1. */
  page?: number;
  /** Default 25, clamped to GitHub's 100-item REST ceiling. */
  perPage?: number;
}

export interface GitHubIssueLabelSummary {
  name: string;
  color: string;
}

export interface GitHubIssueAssigneeSummary {
  login: string;
  avatarUrl?: string;
}

/** Row-shaped issue summary shared by both `listIssuesPage` and `searchIssues`, so the list UI renders both identically. */
export interface GitHubIssueSummary {
  number: number;
  title: string;
  state: string;
  htmlUrl: string;
  labels: GitHubIssueLabelSummary[];
  assignees: GitHubIssueAssigneeSummary[];
  milestoneTitle?: string | null;
  commentsCount: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface GitHubIssueListPage {
  items: GitHubIssueSummary[];
  page: number;
  hasNextPage: boolean;
  /** Present only when `hasNextPage` is true. */
  nextPage?: number;
}

export interface GitHubIssueSearchOptions {
  /** Free-text search terms, appended raw to the assembled qualifier string. */
  q?: string;
  state?: "open" | "closed" | "all";
  /** Comma-joined or array-of label names; each becomes its own `label:` qualifier. */
  labels?: string | string[];
  assignee?: string;
  milestone?: string | number;
  sort?: "created" | "updated" | "comments";
  order?: "asc" | "desc";
  page?: number;
  perPage?: number;
}

export interface GitHubIssueSearchPage extends GitHubIssueListPage {
  totalCount: number;
  /** GitHub's own `incomplete_results` flag: the search timed out server-side before scanning everything. */
  incompleteResults: boolean;
  /** True once the 1,000-result Search API window has been reached -- surfaced explicitly, never silently truncated. */
  cappedAtLimit: boolean;
}

/*
FNXC:GithubPmMilestones 2026-07-25-00:00:
KB-003 extends the FUSI-012 minimal milestone shape ADDITIVELY: `number`/`title`/`state`
keep their exact original meaning and position (issues-routes.ts getIssuesFilterOptions and
IssuesPanel.tsx's milestone filter dropdown consume ONLY those three fields and must keep
compiling/behaving identically). New fields (`description`, `openIssues`, `closedIssues`,
`dueOn`, `htmlUrl`, `createdAt`, `updatedAt`, `closedAt`) feed the milestones management panel's
progress bar and overdue flag -- `openIssues`/`closedIssues` are always numbers (defaulted to
0), never undefined, so `closedIssues / (openIssues + closedIssues)` is always a defined ratio.
*/
export interface GitHubMilestone {
  number: number;
  title: string;
  state: string;
  description?: string | null;
  openIssues: number;
  closedIssues: number;
  dueOn?: string | null;
  htmlUrl?: string;
  createdAt?: string;
  updatedAt?: string;
  closedAt?: string | null;
}

/*
FNXC:GithubPmMilestones 2026-07-25-00:00:
KB-003 list-options: mirrors GitHub's own milestones-list query params exactly (state/sort/
direction) so the panel's progress/overdue numbers come straight off the same payload GitHub's
milestone page renders from. Defaults (state=all, sort=due_on, direction=asc) preserve
listMilestones' prior no-options behavior for the FUSI-012 filter-dropdown caller.
*/
export interface GitHubListMilestonesOptions {
  state?: "open" | "closed" | "all";
  sort?: "due_on" | "completeness";
  direction?: "asc" | "desc";
}

export interface CreateMilestoneInput {
  title: string;
  description?: string;
  /** ISO-8601 due date, or omitted for no due date. */
  dueOn?: string;
  state?: "open" | "closed";
}

export interface UpdateMilestoneInput {
  title?: string;
  description?: string;
  /** ISO-8601 due date; `null` clears the due date; `undefined` leaves it unchanged. */
  dueOn?: string | null;
}

export interface SetMilestoneStateInput {
  state: "open" | "closed";
}

export interface GitHubLabel {
  id: string;
  name: string;
  color: string;
  description?: string | null;
}

/*
FNXC:GithubPmLabels 2026-07-24-10:00:
KB-002 label CRUD types. Deliberately a SEPARATE REST-backed identity from the GraphQL
`listLabels`/`GitHubLabel` pair above (which feeds FUSI-005's taxonomy generator and must
keep its exact signature). `GitHubRestLabel` (the REST list/CRUD return shape) has no GraphQL
`id` -- REST label CRUD is keyed by NAME, so every method below takes/returns `name` as the
identity and never depends on a GraphQL node id.
*/
export interface GitHubRestLabelSummary {
  name: string;
  color: string;
  description?: string | null;
}

export interface CreateLabelInput {
  name: string;
  /** 6 hex digits, with or without a leading '#'. Validated via normalizeGitHubLabelColor before any request is sent. */
  color: string;
  description?: string;
}

export interface UpdateLabelInput {
  /**
   * FNXC:GithubPmLabels 2026-07-24-10:00:
   * KB-002: GitHub's REST `PATCH .../labels/{name}` endpoint takes a `new_name` field to
   * rename a label WITHOUT deleting/recreating it -- this is what preserves the label's
   * existing issue associations across a rename (GitHub's own documented behavior). This
   * method must never implement a rename as delete+create.
   */
  newName?: string;
  color?: string;
  description?: string;
}

export interface GitHubLabelWithUsage extends GitHubRestLabelSummary {
  /** Open-issue count for this label (Search API `total_count`), or null when unavailable (e.g. rate-limited/403 degrade). */
  usageCount: number | null;
}

export interface GitHubTokenScopes {
  scopes: string[];
  hasScope: (scope: string) => boolean;
}

export interface GitHubDiscussionListOptions {
  /** Bounds total items returned across all GraphQL pages. Default: a single page. */
  maxItems?: number;
}

/*
FNXC:GitHubPmClient 2026-07-24-07:00:
FUSI-009 repo-feature probe. One cheap GraphQL read of `repository { hasIssuesEnabled
hasDiscussionsEnabled hasProjectsEnabled viewerPermission }` feeds the repo-context
capability gating resolver (repo-capabilities.ts) so it can grey out a tab (e.g.
Discussions) the repo itself doesn't support, independent of token scope. This stays a
SINGLE read -- callers must not add a second per-tab GraphQL/REST probe on top of it.
*/
export interface GitHubRepositoryFeatures {
  hasIssuesEnabled: boolean;
  hasDiscussionsEnabled: boolean;
  hasProjectsEnabled: boolean;
  /** GitHub's own viewer-permission enum (ADMIN/WRITE/READ/etc.), when resolvable. */
  viewerPermission?: string | null;
}

/*
FNXC:GithubPmIssues 2026-07-24-05:00:
FUSI-014 write-input types. Deliberately reuse `GitHubIssueDetail`/`GitHubIssueComment`
(already declared above for FUSI-013's read path) as the RETURN shape of every write method
below -- every mutation returns GitHub's authoritative post-write object (the round-trip
proof the task requires), mapped through the same REST->camelCase mapper `getIssue` uses,
so a caller never has to special-case "read shape" vs "write-result shape".
*/

export interface CreateIssueInput {
  title: string;
  body?: string;
  /** Label names to apply on creation. */
  labels?: string[];
  /** Assignee logins to apply on creation. */
  assignees?: string[];
  /** A milestone number to attach on creation. */
  milestone?: number;
}

export interface UpdateIssueInput {
  title?: string;
  body?: string;
}

export interface SetIssueStateInput {
  state: "open" | "closed";
  /** Only meaningful when closing; GitHub ignores state_reason when reopening. */
  stateReason?: "completed" | "not_planned" | "reopened";
}

/*
FNXC:GitHubPmClient 2026-07-24-01:00:
FUSI-013 read-only issue-detail reads: getIssue/listIssueComments/listIssueTimeline.
Comments deliberately paginate ONE PAGE AT A TIME (not accumulated via paginateRest)
so a long issue's thread lazy-loads from the UI ('Load more comments') instead of the
client eagerly fetching every page up front -- the task's explicit "must lazy-load"
requirement. listIssueTimeline filters GitHub's broad timeline event stream down to
the handful of "key events" the detail view renders (closed/reopened/labeled/
unlabeled/referenced/cross-referenced); everything else (commented, assigned,
renamed, etc.) is dropped rather than surfaced as an unrecognized shape.
*/

export interface GitHubIssueUser {
  login: string;
  avatarUrl?: string;
}

export interface GitHubIssueLabel {
  name: string;
  color: string;
  description?: string | null;
}

export interface GitHubIssueMilestone {
  title: string;
  state: string;
  dueOn?: string | null;
}

export interface GitHubIssueDetail {
  number: number;
  title: string;
  state: "open" | "closed";
  bodyMarkdown: string;
  htmlUrl: string;
  author: GitHubIssueUser | null;
  createdAt?: string;
  updatedAt?: string;
  labels: GitHubIssueLabel[];
  assignees: GitHubIssueUser[];
  milestone: GitHubIssueMilestone | null;
  commentCount: number;
}

export interface GitHubIssueComment {
  id: number;
  author: GitHubIssueUser | null;
  bodyMarkdown: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface GitHubIssueCommentsPage {
  comments: GitHubIssueComment[];
  /** Next 1-based page number to request, or null when this was the last page. */
  nextPage: number | null;
}

export interface GitHubListIssueCommentsOptions {
  page?: number;
  perPage?: number;
}

export const GITHUB_TIMELINE_KEY_EVENTS = ["closed", "reopened", "labeled", "unlabeled", "referenced", "cross-referenced"] as const;

export type GitHubTimelineEventType = (typeof GITHUB_TIMELINE_KEY_EVENTS)[number];

export interface GitHubTimelineEvent {
  id: string;
  event: GitHubTimelineEventType;
  actor?: GitHubIssueUser;
  createdAt?: string;
  label?: { name: string; color: string };
  source?: { issueNumber?: number; htmlUrl?: string };
}

export interface GitHubListIssueTimelineOptions {
  /** Bounds total raw timeline items scanned before filtering. Default: a single page (100). */
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

/*
FNXC:GithubPmDiscussions 2026-07-25-10:00:
KB-005 discussion BROWSE types -- deliberately separate from `GitHubDiscussionListItem`/
`listDiscussions` above, which stays UNCHANGED (it feeds FUSI-005's taxonomy generator and
its accumulate-all/degrade-to-[] contract must never change). The browse read is built on
GitHub's `search(type: DISCUSSION)` connection (not the plain `discussions` connection) so
results match the qualifiers GitHub's own Discussions tab search bar uses
(`category:`/`is:answered`/`is:unanswered`/`sort:updated`/`sort:created`) -- a plain
`discussions(first, after, orderBy)` read has no equivalent free-text/category/answered
filtering, so it cannot reproduce the same result set the acceptance criteria require.
`GitHubDiscussionCategory` is intentionally NOT named `DiscussionCategorySummary` -- that
name is already taken by taxonomy-proposal.ts's unrelated taxonomy-generation summary type.
*/
export interface GitHubDiscussionCategory {
  id: string;
  name: string;
  slug: string;
  /** Emoji glyph/shortcode text, e.g. "\ud83d\udcac" or ":speech_balloon:". Render this, never `emojiHTML`, via `dangerouslySetInnerHTML`. */
  emoji: string;
  /** GitHub's rendered emoji HTML fragment. Available for callers that need it, but the UI must not inject it as raw HTML. */
  emojiHTML: string;
  isAnswerable: boolean;
  description?: string;
}

/** Row shape returned by `searchDiscussions`, feeding the KB-005 discussion browser's result list. */
export interface GitHubDiscussionBrowseItem {
  number: number;
  title: string;
  url: string;
  categoryName: string | null;
  categoryEmoji: string | null;
  upvoteCount: number;
  commentCount: number;
  /** Derived from `answer != null || answerChosenAt != null` -- true only for a genuinely answered Q&A discussion. */
  isAnswered: boolean;
  authorLogin: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * FNXC:GithubPmDiscussions 2026-07-25-10:00:
 * `category` is the category NAME (not slug/id) -- matching how GitHub's own Discussions tab
 * search bar accepts `category:"Name"`. `sort` defaults to "activity" (`sort:updated`) when
 * omitted, mirroring GitHub's own default Discussions-tab ordering.
 */
export interface GitHubDiscussionBrowseOptions {
  category?: string;
  search?: string;
  sort?: "activity" | "newest";
  answered?: "answered" | "unanswered";
  /** Bounds total items returned across all GraphQL pages. Default: a single page. */
  maxItems?: number;
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
   * FNXC:GithubPmIssues 2026-07-24-05:00:
   * FUSI-014's single JSON-body write helper: routes every POST/PATCH mutation through
   * `fetchThrottled` (same typed-error classification + rate-limit backoff as every read
   * method above) with a `Content-Type: application/json` body. No second transport is
   * introduced -- this is the only place a write request is issued from.
   */
  private async writeJson<T>(url: string, method: "POST" | "PATCH", body: Record<string, unknown>): Promise<T> {
    const { data } = await this.requestJson<T>(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return data;
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
   * FNXC:GithubPmIssues 2026-07-24-03:00:
   * Single-page REST issue-list read (state/labels/assignee/milestone/sort/direction --
   * the same query params GitHub's own issues-list UI uses, so results match exactly).
   * Returns exactly ONE page; `hasNextPage`/`nextPage` are derived from the `Link` header
   * `rel="next"` cursor rather than a client-accumulated fetch loop. PRs are filtered out
   * like `listIssues` does. Deliberately does not touch `listIssues`'s implementation.
   */
  async listIssuesPage(owner: string, repo: string, options: GitHubIssueListPageOptions = {}): Promise<GitHubIssueListPage> {
    const page = normalizePageNumber(options.page);
    const perPage = normalizePerPage(options.perPage);
    const params = new URLSearchParams({
      state: options.state ?? "open",
      sort: options.sort ?? "created",
      direction: options.direction ?? "desc",
      per_page: String(perPage),
      page: String(page),
    });
    if (options.labels) params.set("labels", options.labels);
    if (options.assignee) params.set("assignee", options.assignee);
    if (options.milestone !== undefined && options.milestone !== null && String(options.milestone).trim() !== "") {
      params.set("milestone", String(options.milestone));
    }
    const url = `${GITHUB_REST_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?${params.toString()}`;
    const { data, response } = await this.requestJson<GitHubRestIssueFull[]>(url);
    const raw = Array.isArray(data) ? data : [];
    const items = raw.filter((issue) => !issue.pull_request).map(mapRestIssueToSummary);
    const nextUrl = parseNextLinkUrl(response.headers.get("Link"));
    return { items, page, hasNextPage: Boolean(nextUrl), nextPage: nextUrl ? page + 1 : undefined };
  }

  /**
   * FNXC:GithubPmIssues 2026-07-24-03:00:
   * Free-text issue search via GitHub's Search API (`GET /search/issues`) -- used ONLY when
   * a `q` term is present, since the plain issues-list endpoint has no full-text search. The
   * qualifier string combines `repo:`/`is:issue` plus the same state/label/assignee/milestone
   * filters as `listIssuesPage` so results stay consistent between the two paths, quoting any
   * value containing whitespace. The Search API hard-caps combined `page*per_page` at 1,000
   * results; `cappedAtLimit` surfaces that explicitly rather than silently truncating.
   */
  async searchIssues(owner: string, repo: string, options: GitHubIssueSearchOptions = {}): Promise<GitHubIssueSearchPage> {
    const page = normalizePageNumber(options.page);
    const perPage = normalizePerPage(options.perPage);
    const q = buildIssueSearchQuery(owner, repo, options);
    const params = new URLSearchParams({
      q,
      sort: options.sort ?? "created",
      order: options.order ?? "desc",
      per_page: String(perPage),
      page: String(page),
    });
    const url = `${GITHUB_REST_BASE_URL}/search/issues?${params.toString()}`;
    const { data } = await this.requestJson<GitHubRestSearchResponse>(url);
    const rawItems = Array.isArray(data.items) ? data.items : [];
    const items = rawItems.filter((issue) => !issue.pull_request).map(mapRestIssueToSummary);
    const totalCount = typeof data.total_count === "number" ? data.total_count : items.length;
    const searchWindow = Math.min(totalCount, 1000);
    const cappedAtLimit = totalCount > 1000 || page * perPage >= 1000;
    const reachedWindowEnd = page * perPage >= searchWindow;
    const hasNextPage = !reachedWindowEnd && items.length === perPage;
    return {
      items,
      page,
      hasNextPage,
      nextPage: hasNextPage ? page + 1 : undefined,
      totalCount,
      incompleteResults: data.incomplete_results === true,
      cappedAtLimit,
    };
  }

  /**
   * FNXC:GithubPmIssues 2026-07-24-03:00:
   * Bounded milestones lookup for the issue-list filter dropdown (single page, capped at 100 --
   * sufficient for a dropdown; not intended for exhaustive milestone enumeration).
   *
   * FNXC:GithubPmMilestones 2026-07-25-00:05:
   * KB-003 adds an options object (state/sort/direction, defaulting to the FUSI-012 no-options
   * behavior: state=all) and maps GitHub's `open_issues`/`closed_issues`/`due_on`/`html_url`/
   * `closed_at` fields into the milestones management panel's progress+due-date shape via
   * `mapRestMilestone` -- the SAME mapper `createMilestone`/`updateMilestone`/`setMilestoneState`
   * use, so list/read and write results are shaped identically.
   */
  async listMilestones(owner: string, repo: string, options: GitHubListMilestonesOptions = {}): Promise<GitHubMilestone[]> {
    const params = new URLSearchParams({
      state: options.state ?? "all",
      sort: options.sort ?? "due_on",
      direction: options.direction ?? "asc",
      per_page: "100",
    });
    const url = `${GITHUB_REST_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/milestones?${params.toString()}`;
    const { data } = await this.requestJson<GitHubRestMilestoneFull[]>(url);
    const raw = Array.isArray(data) ? data : [];
    return raw.map(mapRestMilestone);
  }

  /**
   * FNXC:GithubPmMilestones 2026-07-25-00:10:
   * KB-003: `POST /repos/{owner}/{repo}/milestones` -- returns GitHub's authoritative created
   * milestone object, mapped through the same shape `listMilestones` returns.
   */
  async createMilestone(owner: string, repo: string, input: CreateMilestoneInput): Promise<GitHubMilestone> {
    const url = `${GITHUB_REST_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/milestones`;
    const body: Record<string, unknown> = { title: input.title };
    if (input.description !== undefined) body.description = input.description;
    if (input.dueOn !== undefined) body.due_on = input.dueOn;
    if (input.state !== undefined) body.state = input.state;
    const milestone = await this.writeJson<GitHubRestMilestoneFull>(url, "POST", body);
    return mapRestMilestone(milestone);
  }

  /**
   * FNXC:GithubPmMilestones 2026-07-25-00:10:
   * KB-003: `PATCH /repos/{owner}/{repo}/milestones/{number}` for title/description/due-date only
   * -- close/reopen is a SEPARATE method (`setMilestoneState`), mirroring the issue write split
   * between editing content and changing lifecycle state. `dueOn: null` clears the due date.
   */
  async updateMilestone(owner: string, repo: string, number: number, patch: UpdateMilestoneInput): Promise<GitHubMilestone> {
    const url = `${GITHUB_REST_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/milestones/${encodeURIComponent(String(number))}`;
    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) body.title = patch.title;
    if (patch.description !== undefined) body.description = patch.description;
    if (patch.dueOn !== undefined) body.due_on = patch.dueOn;
    const milestone = await this.writeJson<GitHubRestMilestoneFull>(url, "PATCH", body);
    return mapRestMilestone(milestone);
  }

  /**
   * FNXC:GithubPmMilestones 2026-07-25-00:10:
   * KB-003: close/reopen intent via the same `PATCH .../milestones/{number}` endpoint
   * `updateMilestone` uses, kept as a distinct method so callers state lifecycle intent
   * explicitly (mirrors `setIssueState`).
   */
  async setMilestoneState(owner: string, repo: string, number: number, input: SetMilestoneStateInput): Promise<GitHubMilestone> {
    const url = `${GITHUB_REST_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/milestones/${encodeURIComponent(String(number))}`;
    const milestone = await this.writeJson<GitHubRestMilestoneFull>(url, "PATCH", { state: input.state });
    return mapRestMilestone(milestone);
  }

  /**
   * FNXC:GithubPmMilestones 2026-07-25-00:15:
   * KB-003: `DELETE /repos/{owner}/{repo}/milestones/{number}` -- GitHub returns 204 No Content
   * with an EMPTY body. This deliberately calls `fetchThrottled` directly (not `requestJson`,
   * which unconditionally calls `response.json()` and would throw on the empty 204 body) so the
   * same typed-error classification + rate-limit backoff still applies without a JSON parse.
   */
  async deleteMilestone(owner: string, repo: string, number: number): Promise<void> {
    const url = `${GITHUB_REST_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/milestones/${encodeURIComponent(String(number))}`;
    await this.fetchThrottled(url, { method: "DELETE" });
  }

  /**
   * FNXC:GithubPmMilestones 2026-07-25-00:15:
   * KB-003: bounded page-accumulating (via `paginateRest`) lookup of a milestone's OPEN issues
   * only, filtering out pull requests -- feeds the close-with-open-issues reassignment flow
   * (`postMilestoneReassignOpenIssues` iterates this result and PATCHes each issue's milestone).
   */
  async listOpenIssuesForMilestone(owner: string, repo: string, milestoneNumber: number, maxItems = REST_PAGE_SIZE): Promise<GitHubIssueListItem[]> {
    const params = new URLSearchParams({ milestone: String(milestoneNumber), state: "open", per_page: String(REST_PAGE_SIZE) });
    const url = `${GITHUB_REST_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?${params.toString()}`;
    const raw = await this.paginateRest<GitHubRestIssue>(url, maxItems);
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
   * FNXC:GithubPmMilestones 2026-07-25-00:15:
   * KB-003: sets (or clears, when `milestoneNumber` is null) a single issue's milestone via the
   * same `PATCH .../issues/{number}` endpoint `updateIssue`/`setIssueState` use, kept distinct so
   * the reassignment flow states its narrow intent explicitly without touching title/body/state.
   */
  async setIssueMilestone(owner: string, repo: string, number: number, milestoneNumber: number | null): Promise<GitHubIssueDetail> {
    const url = `${GITHUB_REST_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(String(number))}`;
    const issue = await this.writeJson<GitHubRestIssueDetail>(url, "PATCH", { milestone: milestoneNumber });
    return mapRestIssueToDetail(issue, number);
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
   * FNXC:GithubPmLabels 2026-07-24-10:00:
   * KB-002: REST label list, `GET /repos/{owner}/{repo}/labels?per_page=100`, paginated via
   * the shared `paginateRest` Link-header cursor (same helper `listIssues` uses). This is a
   * SEPARATE read path from the GraphQL `listLabels` above -- REST is name-keyed, which is
   * what CRUD identity needs, and this method's signature/callers are independent of FUSI-005's
   * taxonomy generator (which keeps using the GraphQL method unchanged).
   */
  async listLabelsRest(owner: string, repo: string): Promise<GitHubRestLabelSummary[]> {
    const url = `${GITHUB_REST_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/labels?per_page=${REST_PAGE_SIZE}`;
    const raw = await this.paginateRest<GitHubRestLabelFull>(url, Number.MAX_SAFE_INTEGER);
    return raw.map(mapRestLabel);
  }

  /**
   * FNXC:GithubPmLabels 2026-07-24-10:00:
   * KB-002: per-label OPEN-issue usage count via the Search API's `total_count`
   * (`GET /search/issues?q=repo:{owner}/{repo}+is:issue+is:open+label:"{name}"&per_page=1`).
   * `per_page=1` keeps this cheap -- only the count is read, never `items`. Reuses
   * `quoteSearchQualifierIfNeeded` so a label name containing whitespace is quoted exactly
   * like `buildIssueSearchQuery`'s `label:` qualifier already does for issue-list filtering.
   */
  async getLabelUsageCount(owner: string, repo: string, name: string): Promise<number> {
    const q = `repo:${owner}/${repo} is:issue is:open label:${quoteSearchQualifierIfNeeded(name)}`;
    const params = new URLSearchParams({ q, per_page: "1" });
    const url = `${GITHUB_REST_BASE_URL}/search/issues?${params.toString()}`;
    const { data } = await this.requestJson<GitHubRestSearchResponse>(url);
    return typeof data.total_count === "number" ? data.total_count : 0;
  }

  /**
   * FNXC:GithubPmLabels 2026-07-24-10:00:
   * KB-002: `POST /repos/{owner}/{repo}/labels` -- creates a label and returns GitHub's
   * authoritative created object (the round-trip proof), mapped through the same
   * `GitHubRestLabelSummary` shape `listLabelsRest` returns. The color is validated/normalized
   * BEFORE any request is sent -- an invalid color never reaches GitHub.
   */
  async createLabel(owner: string, repo: string, input: CreateLabelInput): Promise<GitHubRestLabelSummary> {
    const color = normalizeGitHubLabelColor(input.color);
    if (!color) {
      throw new GitHubApiError(400, `Invalid label color "${input.color}". Use six hex digits, e.g. "d73a4a".`, "invalid_color");
    }
    const url = `${GITHUB_REST_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/labels`;
    const body: Record<string, unknown> = { name: input.name, color };
    if (input.description !== undefined) body.description = input.description;
    const label = await this.writeJson<GitHubRestLabelFull>(url, "POST", body);
    return mapRestLabel(label);
  }

  /**
   * FNXC:GithubPmLabels 2026-07-24-10:00:
   * KB-002: `PATCH /repos/{owner}/{repo}/labels/{currentName}`. A rename sends GitHub's
   * `new_name` field (never delete+recreate) so existing issue associations are preserved --
   * see UpdateLabelInput.newName's doc comment for the exact GitHub contract this relies on.
   * Returns the authoritative updated label (round-trip proof).
   */
  async updateLabel(owner: string, repo: string, currentName: string, patch: UpdateLabelInput): Promise<GitHubRestLabelSummary> {
    let color: string | undefined;
    if (patch.color !== undefined) {
      const normalized = normalizeGitHubLabelColor(patch.color);
      if (!normalized) {
        throw new GitHubApiError(400, `Invalid label color "${patch.color}". Use six hex digits, e.g. "d73a4a".`, "invalid_color");
      }
      color = normalized;
    }
    const url = `${GITHUB_REST_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/labels/${encodeURIComponent(currentName)}`;
    const body: Record<string, unknown> = {};
    if (patch.newName !== undefined) body.new_name = patch.newName;
    if (color !== undefined) body.color = color;
    if (patch.description !== undefined) body.description = patch.description;
    const label = await this.writeJson<GitHubRestLabelFull>(url, "PATCH", body);
    return mapRestLabel(label);
  }

  /**
   * FNXC:GithubPmLabels 2026-07-24-10:00:
   * KB-002: `DELETE /repos/{owner}/{repo}/labels/{name}`. GitHub returns `204 No Content` on
   * success -- this calls `fetchThrottled` directly (not `requestJson`/`writeJson`, both of
   * which unconditionally parse a JSON body) so an empty 204 response body is tolerated rather
   * than throwing a JSON-parse error. Still routes through the SAME throttled/error-classifying
   * transport every other method uses -- no second transport is introduced.
   */
  async deleteLabel(owner: string, repo: string, name: string): Promise<{ deleted: true }> {
    const url = `${GITHUB_REST_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/labels/${encodeURIComponent(name)}`;
    await this.fetchThrottled(url, { method: "DELETE" });
    return { deleted: true };
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
   * FNXC:GithubPmDiscussions 2026-07-25-10:10:
   * KB-005: `repository { discussionCategories(first: 100) { nodes {...} } }` -- a single
   * (non-paginated) page is sufficient for a category rail; GitHub repos practically never
   * exceed 100 discussion categories. Nodes missing an `id`/`name` are filtered out.
   */
  async listDiscussionCategories(owner: string, repo: string): Promise<GitHubDiscussionCategory[]> {
    const data = await this.graphql<{
      repository?: {
        discussionCategories?: {
          nodes?: Array<{
            id?: string;
            name?: string;
            slug?: string;
            emoji?: string;
            emojiHTML?: string;
            isAnswerable?: boolean;
            description?: string | null;
          } | null>;
        };
      };
    }>(GITHUB_DISCUSSION_CATEGORIES_QUERY, { owner, repo });
    const nodes = data.repository?.discussionCategories?.nodes ?? [];
    return nodes
      .filter((node): node is NonNullable<typeof node> => Boolean(node && node.id && node.name))
      .map((node) => ({
        id: node.id as string,
        name: node.name as string,
        slug: node.slug ?? "",
        emoji: node.emoji ?? "",
        emojiHTML: node.emojiHTML ?? "",
        isAnswerable: node.isAnswerable === true,
        description: node.description ?? undefined,
      }));
  }

  /**
   * FNXC:GithubPmDiscussions 2026-07-25-10:15:
   * KB-005: browse discussions via GitHub's `search(type: DISCUSSION)` connection so results
   * match GitHub's own Discussions-tab search bar exactly. The search query string is built
   * deterministically by the standalone, unit-testable `buildDiscussionSearchQuery` (below) --
   * this method never assembles the qualifier string inline. Cursor-paginated through the
   * shared `paginateGraphQl` bounded by `options.maxItems ?? GRAPHQL_PAGE_SIZE`.
   */
  async searchDiscussions(owner: string, repo: string, options: GitHubDiscussionBrowseOptions = {}): Promise<GitHubDiscussionBrowseItem[]> {
    const maxItems = options.maxItems ?? GRAPHQL_PAGE_SIZE;
    const query = buildDiscussionSearchQuery(owner, repo, options);
    return this.paginateGraphQl<GitHubDiscussionBrowseItem>(async (after) => {
      const data = await this.graphql<{
        search?: {
          nodes?: Array<GitHubRestDiscussionSearchNode | null>;
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        };
      }>(GITHUB_DISCUSSION_SEARCH_QUERY, { query, first: Math.min(GRAPHQL_PAGE_SIZE, maxItems), after: after ?? null });
      const connection = data.search;
      const nodes = (connection?.nodes ?? [])
        .filter((node): node is GitHubRestDiscussionSearchNode => Boolean(node && typeof node.number === "number"))
        .map(mapDiscussionSearchNode);
      return {
        nodes,
        pageInfo: { hasNextPage: connection?.pageInfo?.hasNextPage === true, endCursor: connection?.pageInfo?.endCursor ?? null },
      };
    }, maxItems);
  }

  /**
   * FNXC:GitHubPmClient 2026-07-24-01:00:
   * FUSI-013: fetch a single issue's full detail. Rejects a pull_request-shaped payload
   * (GitHub's issues REST endpoint also serves PRs by number) with a not_found-style error
   * since this surface is issues-only -- callers should not render a PR through the issue view.
   */
  async getIssue(owner: string, repo: string, number: number): Promise<GitHubIssueDetail> {
    const url = `${GITHUB_REST_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(String(number))}`;
    const { data: issue } = await this.requestJson<GitHubRestIssueDetail>(url);
    return mapRestIssueToDetail(issue, number);
  }

  /**
   * FNXC:GithubPmIssues 2026-07-24-05:00:
   * FUSI-014: `POST /repos/{owner}/{repo}/issues` -- creates a new issue and returns GitHub's
   * authoritative post-write issue object (the round-trip proof), mapped through the same
   * shape `getIssue` returns so a caller renders create/read results identically.
   */
  async createIssue(owner: string, repo: string, input: CreateIssueInput): Promise<GitHubIssueDetail> {
    const url = `${GITHUB_REST_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`;
    const body: Record<string, unknown> = { title: input.title };
    if (input.body !== undefined) body.body = input.body;
    if (input.labels && input.labels.length > 0) body.labels = input.labels;
    if (input.assignees && input.assignees.length > 0) body.assignees = input.assignees;
    if (input.milestone !== undefined) body.milestone = input.milestone;
    const issue = await this.writeJson<GitHubRestIssueDetail>(url, "POST", body);
    return mapRestIssueToDetail(issue);
  }

  /**
   * FNXC:GithubPmIssues 2026-07-24-05:00:
   * FUSI-014: `PATCH /repos/{owner}/{repo}/issues/{number}` for title/body only -- close/reopen
   * is a SEPARATE method (`setIssueState`) below, mirroring GitHub's own semantic split between
   * editing content and changing lifecycle state even though both hit the same REST endpoint.
   */
  async updateIssue(owner: string, repo: string, number: number, patch: UpdateIssueInput): Promise<GitHubIssueDetail> {
    const url = `${GITHUB_REST_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(String(number))}`;
    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) body.title = patch.title;
    if (patch.body !== undefined) body.body = patch.body;
    const issue = await this.writeJson<GitHubRestIssueDetail>(url, "PATCH", body);
    return mapRestIssueToDetail(issue, number);
  }

  /**
   * FNXC:GithubPmIssues 2026-07-24-05:00:
   * FUSI-014: close (with an optional `state_reason` of "completed"/"not_planned") or reopen
   * (state="open", state_reason ignored by GitHub but forwarded if the caller supplied
   * "reopened" for symmetry) via the same `PATCH .../issues/{number}` endpoint `updateIssue`
   * uses, kept as a distinct method so callers state intent explicitly.
   */
  async setIssueState(owner: string, repo: string, number: number, input: SetIssueStateInput): Promise<GitHubIssueDetail> {
    const url = `${GITHUB_REST_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(String(number))}`;
    const body: Record<string, unknown> = { state: input.state };
    if (input.stateReason !== undefined) body.state_reason = input.stateReason;
    const issue = await this.writeJson<GitHubRestIssueDetail>(url, "PATCH", body);
    return mapRestIssueToDetail(issue, number);
  }

  /**
   * FNXC:GithubPmIssues 2026-07-24-05:00:
   * FUSI-014: `POST /repos/{owner}/{repo}/issues/{number}/comments` -- returns the authoritative
   * created comment, mapped through the same `GitHubIssueComment` shape `listIssueComments` uses.
   */
  async createIssueComment(owner: string, repo: string, number: number, body: string): Promise<GitHubIssueComment> {
    const url = `${GITHUB_REST_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(String(number))}/comments`;
    const comment = await this.writeJson<GitHubRestComment>(url, "POST", { body });
    return mapRestComment(comment);
  }

  /**
   * FNXC:GithubPmIssues 2026-07-24-05:00:
   * FUSI-014: `PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}` -- note this endpoint
   * is keyed by the comment's own id, NOT the issue number (GitHub's REST shape), so this
   * method deliberately does not take an issue number parameter.
   */
  async updateIssueComment(owner: string, repo: string, commentId: number, body: string): Promise<GitHubIssueComment> {
    const url = `${GITHUB_REST_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${encodeURIComponent(String(commentId))}`;
    const comment = await this.writeJson<GitHubRestComment>(url, "PATCH", { body });
    return mapRestComment(comment);
  }

  /**
   * FNXC:GitHubPmClient 2026-07-24-01:00:
   * FUSI-013: page-at-a-time comment fetch (NOT accumulated via paginateRest) so the
   * IssueDetailView can lazy-load a long thread instead of loading it all up front.
   * `nextPage` is derived from the REST `Link: rel="next"` header's `page` query param;
   * absence of that header (or an unparsable page number) means this was the last page.
   */
  async listIssueComments(owner: string, repo: string, number: number, options: GitHubListIssueCommentsOptions = {}): Promise<GitHubIssueCommentsPage> {
    const page = options.page ?? 1;
    const perPage = options.perPage ?? REST_PAGE_SIZE;
    const params = new URLSearchParams({ per_page: String(perPage), page: String(page) });
    const url = `${GITHUB_REST_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(String(number))}/comments?${params.toString()}`;
    const { data, response } = await this.requestJson<GitHubRestComment[]>(url);
    const comments = (Array.isArray(data) ? data : []).map((comment) => ({
      id: comment.id,
      author: toGitHubIssueUser(comment.user),
      bodyMarkdown: comment.body ?? "",
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
    }));
    const nextUrl = parseNextLinkUrl(response.headers.get("Link"));
    const nextPage = nextUrl ? parsePageParam(nextUrl) : null;
    return { comments, nextPage };
  }

  /**
   * FNXC:GitHubPmClient 2026-07-24-01:00:
   * FUSI-013: paginate the full timeline (via `paginateRest`, reusing the existing Link-header
   * cursor pagination) then filter down to the "key events" the detail view renders --
   * closed/reopened/labeled/unlabeled/referenced/cross-referenced. Unrecognized event types
   * (commented, assigned, renamed, etc.) are dropped, not surfaced as an unknown shape.
   */
  async listIssueTimeline(owner: string, repo: string, number: number, options: GitHubListIssueTimelineOptions = {}): Promise<GitHubTimelineEvent[]> {
    const maxItems = options.maxItems ?? REST_PAGE_SIZE;
    const url = `${GITHUB_REST_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(String(number))}/timeline?per_page=${REST_PAGE_SIZE}`;
    const raw = await this.paginateRest<GitHubRestTimelineEvent>(url, maxItems);
    const keyEvents = new Set<string>(GITHUB_TIMELINE_KEY_EVENTS);
    return raw
      .filter((event) => typeof event.event === "string" && keyEvents.has(event.event))
      .map((event) => ({
        id: String(event.id ?? event.node_id ?? `${event.event}-${event.created_at ?? ""}`),
        event: event.event as GitHubTimelineEventType,
        actor: toGitHubIssueUser(event.actor) ?? undefined,
        createdAt: event.created_at,
        label: event.label ? { name: event.label.name, color: event.label.color } : undefined,
        source: event.source
          ? { issueNumber: event.source.issue?.number, htmlUrl: event.source.issue?.html_url }
          : undefined,
      }));
  }

  /**
   * FNXC:GitHubPmClient 2026-07-24-07:00:
   * FUSI-009: one cheap GraphQL read of the repo's feature flags (Issues/Discussions/Projects
   * enabled) plus the viewer's permission level. A null `repository` (repo not found, or the
   * token has no access -- GitHub returns `data.repository: null` rather than a top-level
   * error for this case) maps to a `GitHubApiError(404, ..., "not_found")` through the SAME
   * error path every other not-found case uses; this method never invents a bespoke error
   * shape. Callers must not add a second per-tab feature probe on top of this single read.
   */
  async getRepositoryFeatures(owner: string, repo: string): Promise<GitHubRepositoryFeatures> {
    const data = await this.graphql<{
      repository?: {
        hasIssuesEnabled?: boolean;
        hasDiscussionsEnabled?: boolean;
        hasProjectsEnabled?: boolean;
        viewerPermission?: string | null;
      } | null;
    }>(GITHUB_REPOSITORY_FEATURES_QUERY, { owner, repo });
    const repository = data.repository;
    if (!repository) {
      throw new GitHubApiError(404, `Repository ${owner}/${repo} was not found or is not accessible with the current token.`, "not_found");
    }
    return {
      hasIssuesEnabled: repository.hasIssuesEnabled === true,
      hasDiscussionsEnabled: repository.hasDiscussionsEnabled === true,
      hasProjectsEnabled: repository.hasProjectsEnabled === true,
      viewerPermission: repository.viewerPermission ?? null,
    };
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

interface GitHubRestUser {
  login?: string;
  avatar_url?: string;
}

interface GitHubRestLabel {
  name?: string;
  color?: string;
  description?: string | null;
}

interface GitHubRestMilestone {
  title: string;
  state: string;
  due_on?: string | null;
}

/** KB-002: raw REST label shape (list + create/update responses share this). */
interface GitHubRestLabelFull {
  name?: string;
  color?: string;
  description?: string | null;
}

/*
FNXC:GithubPmMilestones 2026-07-25-00:00:
KB-003: full REST milestone payload shape (superset of `GitHubRestMilestone` above, which stays
unchanged since it is embedded inline on an issue's `milestone` field, not the milestones-list
/write endpoints this interface backs).
*/
interface GitHubRestMilestoneFull {
  number: number;
  title: string;
  state: string;
  description?: string | null;
  open_issues?: number;
  closed_issues?: number;
  due_on?: string | null;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
}

interface GitHubRestIssueDetail {
  number: number;
  title: string;
  state: string;
  body?: string | null;
  html_url: string;
  user?: GitHubRestUser | null;
  created_at?: string;
  updated_at?: string;
  labels?: Array<string | GitHubRestLabel>;
  assignees?: GitHubRestUser[];
  milestone?: GitHubRestMilestone | null;
  comments?: number;
  pull_request?: unknown;
}

interface GitHubRestComment {
  id: number;
  user?: GitHubRestUser | null;
  body?: string | null;
  created_at?: string;
  updated_at?: string;
}

interface GitHubRestTimelineEvent {
  id?: number;
  node_id?: string;
  event?: string;
  actor?: GitHubRestUser | null;
  created_at?: string;
  label?: { name: string; color: string };
  source?: { issue?: { number?: number; html_url?: string } };
}

/**
 * FNXC:GithubPmLabels 2026-07-24-10:00:
 * KB-002: shared REST-label -> `GitHubRestLabelSummary` mapper used by `listLabelsRest`,
 * `createLabel`, and `updateLabel` so every label read/write returns the SAME shape.
 */
function mapRestLabel(label: GitHubRestLabelFull): GitHubRestLabelSummary {
  return { name: label.name ?? "", color: label.color ?? "", description: label.description ?? null };
}

function toGitHubIssueUser(user: GitHubRestUser | null | undefined): GitHubIssueUser | null {
  if (!user || typeof user.login !== "string" || !user.login) return null;
  return { login: user.login, avatarUrl: user.avatar_url };
}

function toGitHubIssueLabel(label: string | GitHubRestLabel): GitHubIssueLabel | null {
  if (typeof label === "string") return { name: label, color: "" };
  if (!label.name) return null;
  return { name: label.name, color: label.color ?? "", description: label.description ?? null };
}

/**
 * FNXC:GithubPmIssues 2026-07-24-05:00:
 * Shared REST-issue -> `GitHubIssueDetail` mapper, extracted from `getIssue`'s original inline
 * mapping so every write method (`createIssue`/`updateIssue`/`setIssueState`) returns the SAME
 * shape a read does -- the round-trip proof the task requires. `expectedNumber`, when supplied,
 * rejects a pull_request-shaped payload exactly like `getIssue` originally did (creation never
 * has this ambiguity, so it is omitted from `createIssue`'s call).
 */
function mapRestIssueToDetail(issue: GitHubRestIssueDetail, expectedNumber?: number): GitHubIssueDetail {
  if (issue.pull_request) {
    throw new GitHubApiError(404, `#${expectedNumber ?? issue.number} is a pull request, not an issue.`, "not_found");
  }
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state === "closed" ? "closed" : "open",
    bodyMarkdown: issue.body ?? "",
    htmlUrl: issue.html_url,
    author: toGitHubIssueUser(issue.user),
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    labels: (issue.labels ?? []).map(toGitHubIssueLabel).filter((label): label is GitHubIssueLabel => label !== null),
    assignees: (issue.assignees ?? []).map(toGitHubIssueUser).filter((assignee): assignee is GitHubIssueUser => assignee !== null),
    milestone: issue.milestone
      ? { title: issue.milestone.title, state: issue.milestone.state, dueOn: issue.milestone.due_on ?? null }
      : null,
    commentCount: issue.comments ?? 0,
  };
}

/** Shared REST-comment -> `GitHubIssueComment` mapper, mirroring `listIssueComments`'s inline mapping. */
function mapRestComment(comment: GitHubRestComment): GitHubIssueComment {
  return {
    id: comment.id,
    author: toGitHubIssueUser(comment.user),
    bodyMarkdown: comment.body ?? "",
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
  };
}

/*
FNXC:GithubPmMilestones 2026-07-25-00:00:
Shared REST-milestone -> `GitHubMilestone` mapper used by `listMilestones`/`createMilestone`/
`updateMilestone`/`setMilestoneState` so every read AND write result is shaped identically --
the round-trip proof this task requires. `openIssues`/`closedIssues` always default to 0
(never undefined) so the panel's `closed/(open+closed)` ratio is always a defined number.
*/
function mapRestMilestone(milestone: GitHubRestMilestoneFull): GitHubMilestone {
  return {
    number: milestone.number,
    title: milestone.title,
    state: milestone.state,
    description: milestone.description ?? null,
    openIssues: typeof milestone.open_issues === "number" ? milestone.open_issues : 0,
    closedIssues: typeof milestone.closed_issues === "number" ? milestone.closed_issues : 0,
    dueOn: milestone.due_on ?? null,
    htmlUrl: milestone.html_url,
    createdAt: milestone.created_at,
    updatedAt: milestone.updated_at,
    closedAt: milestone.closed_at ?? null,
  };
}

/** Extracts the `page` query param from a REST pagination URL, e.g. one produced by parseNextLinkUrl. */
function parsePageParam(url: string): number | null {
  try {
    const parsed = new URL(url);
    const page = Number.parseInt(parsed.searchParams.get("page") ?? "", 10);
    return Number.isFinite(page) && page > 0 ? page : null;
  } catch {
    return null;
  }
}

/** Superset of GitHubRestIssue carrying the additional fields FUSI-012's row summary needs. */
interface GitHubRestIssueFull extends GitHubRestIssue {
  labels?: Array<string | { name?: string; color?: string }>;
  assignees?: Array<{ login?: string; avatar_url?: string }>;
  milestone?: { title?: string } | null;
  comments?: number;
}

interface GitHubRestSearchResponse {
  total_count?: number;
  incomplete_results?: boolean;
  items?: GitHubRestIssueFull[];
}

const ISSUE_LIST_DEFAULT_PER_PAGE = 25;
const ISSUE_LIST_MAX_PER_PAGE = 100;

function normalizePageNumber(page: number | undefined): number {
  return Number.isFinite(page) && (page as number) > 0 ? Math.floor(page as number) : 1;
}

function normalizePerPage(perPage: number | undefined): number {
  if (!Number.isFinite(perPage) || (perPage as number) <= 0) return ISSUE_LIST_DEFAULT_PER_PAGE;
  return Math.min(Math.floor(perPage as number), ISSUE_LIST_MAX_PER_PAGE);
}

/**
 * FNXC:GithubPmIssues 2026-07-24-03:00:
 * Maps one raw REST issue (from either the plain issues-list endpoint or a Search API item --
 * both share this shape) into the row-summary type both `listIssuesPage` and `searchIssues`
 * return, so the list UI never has to special-case which backend served a given page.
 */
function mapRestIssueToSummary(issue: GitHubRestIssueFull): GitHubIssueSummary {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    htmlUrl: issue.html_url,
    labels: (issue.labels ?? [])
      .map((label) => (typeof label === "string" ? { name: label, color: "ededed" } : { name: label.name ?? "", color: label.color ?? "ededed" }))
      .filter((label) => Boolean(label.name)),
    assignees: (issue.assignees ?? [])
      .map((assignee) => ({ login: assignee.login ?? "", avatarUrl: assignee.avatar_url }))
      .filter((assignee) => Boolean(assignee.login)),
    milestoneTitle: issue.milestone?.title ?? null,
    commentsCount: typeof issue.comments === "number" ? issue.comments : 0,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
  };
}

function quoteSearchQualifierIfNeeded(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

/**
 * FNXC:GithubPmIssues 2026-07-24-03:00:
 * Assembles the `q` qualifier string for `searchIssues`: `repo:{owner}/{repo} is:issue` plus
 * `state:`/`label:`(one per label)/`assignee:`/`milestone:` qualifiers mirroring the same
 * filters `listIssuesPage` accepts, quoting any value containing whitespace, with the raw
 * free-text `q` term appended last.
 */
function buildIssueSearchQuery(owner: string, repo: string, options: GitHubIssueSearchOptions): string {
  const parts: string[] = [`repo:${owner}/${repo}`, "is:issue"];
  if (options.state && options.state !== "all") parts.push(`state:${options.state}`);
  const labels = Array.isArray(options.labels) ? options.labels : options.labels ? options.labels.split(",") : [];
  for (const label of labels) {
    const trimmed = label.trim();
    if (trimmed) parts.push(`label:${quoteSearchQualifierIfNeeded(trimmed)}`);
  }
  if (options.assignee) parts.push(`assignee:${options.assignee}`);
  if (options.milestone !== undefined && options.milestone !== null && String(options.milestone).trim() !== "") {
    parts.push(`milestone:${quoteSearchQualifierIfNeeded(String(options.milestone))}`);
  }
  const freeText = options.q?.trim();
  if (freeText) parts.push(freeText);
  return parts.join(" ");
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

/*
FNXC:GithubPmDiscussions 2026-07-25-10:20:
KB-005 query constants, placed with the other query constants per this file's convention.
A single non-paginated `discussionCategories(first: 100)` page (categories rarely exceed
that count) feeds the category rail; the browse list uses `search(type: DISCUSSION)`
(NOT the plain `discussions` connection `GITHUB_DISCUSSIONS_QUERY` above uses) because only
the search connection supports the qualifier-based filtering (`category:`/`is:answered`/
`sort:`/free text) GitHub's own Discussions-tab search bar exposes.
*/
const GITHUB_DISCUSSION_CATEGORIES_QUERY = `query FusionGitHubPmDiscussionCategories($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    discussionCategories(first: 100) {
      nodes { id name slug emoji emojiHTML isAnswerable description }
    }
  }
}`;

const GITHUB_DISCUSSION_SEARCH_QUERY = `query FusionGitHubPmDiscussionSearch($query: String!, $first: Int!, $after: String) {
  search(query: $query, type: DISCUSSION, first: $first, after: $after) {
    nodes {
      ... on Discussion {
        number
        title
        url
        category { name emoji isAnswerable }
        upvoteCount
        comments { totalCount }
        answer { id }
        answerChosenAt
        author { login }
        createdAt
        updatedAt
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

interface GitHubRestDiscussionSearchNode {
  number: number;
  title: string;
  url: string;
  category?: { name?: string; emoji?: string; isAnswerable?: boolean } | null;
  upvoteCount?: number;
  comments?: { totalCount?: number };
  answer?: { id?: string } | null;
  answerChosenAt?: string | null;
  author?: { login?: string } | null;
  createdAt?: string;
  updatedAt?: string;
}

function mapDiscussionSearchNode(node: GitHubRestDiscussionSearchNode): GitHubDiscussionBrowseItem {
  return {
    number: node.number,
    title: node.title,
    url: node.url,
    categoryName: node.category?.name ?? null,
    categoryEmoji: node.category?.emoji ?? null,
    upvoteCount: typeof node.upvoteCount === "number" ? node.upvoteCount : 0,
    commentCount: typeof node.comments?.totalCount === "number" ? node.comments.totalCount : 0,
    isAnswered: node.answer != null || node.answerChosenAt != null,
    authorLogin: node.author?.login ?? null,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

/** Quotes a discussion category name for the `category:"…"` search qualifier, escaping any embedded double quote. */
function quoteDiscussionCategoryName(name: string): string {
  return `"${name.trim().replace(/"/gu, '\\"')}"`;
}

/**
 * FNXC:GithubPmDiscussions 2026-07-25-10:25:
 * KB-005 search-query-fidelity contract (acceptance-critical): deterministically assembles the
 * `query` string for `searchDiscussions` so it exactly matches GitHub's own Discussions-tab
 * search-bar qualifiers -- always `repo:{owner}/{repo}`; `category:"Name"` (quoted, escaping
 * embedded quotes) when `options.category` is set; `is:answered`/`is:unanswered` when
 * `options.answered` is set; `sort:updated` for "activity" (the default) or `sort:created` for
 * "newest"; the trimmed free-text `options.search` appended LAST. Exported standalone (not
 * inlined in `searchDiscussions`) so the query-fidelity assertion this task requires can unit
 * test it directly without mocking GraphQL, and so `discussion-routes.ts` can echo the exact
 * same string back to the caller via the response's `query` field.
 */
export function buildDiscussionSearchQuery(owner: string, repo: string, options: GitHubDiscussionBrowseOptions = {}): string {
  const parts: string[] = [`repo:${owner}/${repo}`];
  if (options.category && options.category.trim()) parts.push(`category:${quoteDiscussionCategoryName(options.category)}`);
  if (options.answered === "answered") parts.push("is:answered");
  else if (options.answered === "unanswered") parts.push("is:unanswered");
  parts.push(options.sort === "newest" ? "sort:created" : "sort:updated");
  const freeText = options.search?.trim();
  if (freeText) parts.push(freeText);
  return parts.join(" ");
}

const GITHUB_REPOSITORY_FEATURES_QUERY = `query FusionGitHubPmRepositoryFeatures($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    hasIssuesEnabled
    hasDiscussionsEnabled
    hasProjectsEnabled
    viewerPermission
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
