# GitHub PM Plugin

`fusion-plugin-github-pm` is a bundled Fusion integration plugin for general-purpose, GitHub-native project management: issues, discussions, Projects v2 boards, labels, and milestones for any repository, from inside Fusion. It follows the `fusion-plugin-linear-import` pattern — plugin-owned settings, routes, tools, and a dashboard view, not host-owned `/api/github-pm/*` routes or core GitHub PM settings.

## Scaffold scope (FUSI-001)

This package ships the skeleton:

- `manifest.json` with a `settingsSchema` declaring the setting keys (`personalAccessToken`, `defaultRepo`, `defaultAutonomy`) and a `dashboardViews` entry.
- A plugin-owned `GET /status` route that reports `{ ok, configured, autonomy, defaultRepo }` derived only from settings presence — no GitHub API calls.
- A placeholder `github_pm_status` agent tool.
- A dashboard view showing configuration status and (as of FUSI-002) the authentication diagnostics panel described below.

**Not implemented yet** (deliberately out of scope for FUSI-001/FUSI-002/FUSI-008):

- The any-repo picker UI — later feature (FUSI-007), built on top of the per-repo config storage below (FUSI-004) and attaching into the view shell's repo-picker slot (FUSI-008).
- Live issue/discussion/Projects v2/label/milestone CRUD — later Foundation-milestone tasks; each tab in the shell below is currently a labeled placeholder.
- Per-tab capability gating / grey-out (FUSI-009) — the tab-bar's `disabled`/`disabledReason` fields exist but are unpopulated.
- The dashboard view, routes, and tools do not call the GitHub client yet — that wiring lands in later slices now that both the auth resolver (FUSI-002) and the GitHub client (FUSI-003) can supply/consume a token.

## Dashboard view shell (FUSI-008)

`GitHubPmView.tsx` is the top-level, lazy-loaded dashboard view and the durable shell every later Foundation surface plugs into:

- **Repo-context header** — shows the currently-selected repo (sourced from `GET /repo-config`'s `selectedRepo`, which wraps FUSI-004's `resolveSelectedRepo`, falling back to `/status`'s `defaultRepo`) or a "No repository selected" state. Includes an intentionally-empty mount slot (`.github-pm-view__repo-picker-slot`) for FUSI-007's repo picker.
- **Tab bar** (`GitHubPmTabs.tsx`) — an accessible `role="tablist"`/`role="tab"` bar for the six declared surfaces: Issues, Labels, Milestones, Discussions, Projects, Triage. Keyboard-navigable (Left/Right/Home/End); a `disabled`/`disabledReason` field per tab is reserved for FUSI-009's capability gating.
- **Tab panels** — one `role="tabpanel"` per tab, kept mounted at all times (visibility toggled via the `hidden` attribute, never conditionally unmounted) so each panel's local state survives a tab round-trip. Each panel currently renders placeholder copy naming the milestone that will fill it.
- The settings-presence status badge and `AuthDiagnosticsPanel` (FUSI-002) continue to render inside the shell, unchanged.
- All styling uses design tokens only (`GitHubPmView.css`) and adapts at the existing `@media (max-width: 48rem)` mobile breakpoint (the tab bar scrolls horizontally rather than clipping).

## Issues list — filters, search, sort, pagination (FUSI-012)

The **Issues** tab (previously a placeholder) now renders `IssuesPanel`, a filterable/searchable/sortable, page-at-a-time issue list mounted via `{ repo, context }` — the only structural change FUSI-012 makes to `GitHubPmView.tsx`.

**Client reads** (`src/github-client.ts`, additive — `listIssues`'s accumulate-all contract used by the taxonomy proposal aggregator is untouched):

- `listIssuesPage(owner, repo, options)` — one REST page from `GET /repos/{owner}/{repo}/issues` (`state`/`labels`/`assignee`/`milestone`/`sort`/`direction`/`page`/`perPage`, default `perPage` 25, max 100). `hasNextPage`/`nextPage` derive from the `Link` header `rel="next"` cursor. Never accumulates pages internally.
- `searchIssues(owner, repo, options)` — GitHub Search API (`GET /search/issues`), dispatched only when a free-text term is present (the plain issues-list endpoint has no full-text search). Builds a `repo:`/`is:issue`/`state:`/`label:`/`assignee:`/`milestone:` qualifier string (quoting values with spaces) plus the raw search term. Returns `totalCount`, `incompleteResults`, and `cappedAtLimit` (true once GitHub's hard 1,000-result search window is reached — surfaced explicitly, never silently truncated).
- `listMilestones(owner, repo)` — single bounded page (`state=all`, `per_page=100`) for the milestone filter dropdown. The label filter reuses the existing `listLabels` (GraphQL) reader; no second label method was added.

Both `listIssuesPage` and `searchIssues` map their raw REST items into the same `GitHubIssueSummary` shape (`number`, `title`, `state`, `htmlUrl`, `labels`, `assignees`, `milestoneTitle`, `commentsCount`, `createdAt`, `updatedAt`) so the panel renders both response paths identically.

**Routes** (plugin-scoped under `/api/plugins/fusion-plugin-github-pm/*`, `src/issues-routes.ts`):

- `GET /issues/list?repo=&state=&labels=&assignee=&milestone=&search=&sort=&direction=&page=&perPage=` — dispatches to `searchIssues` when `search` is non-empty, otherwise `listIssuesPage`. Repo resolves from the `repo` query param, falling back to `resolveSelectedRepo(ctx.settings)` (FUSI-004). Response: `{ ok, repo, mode: "list" | "search", items, page, perPage, hasNextPage, nextPage?, totalCount?, incompleteResults?, cappedAtLimit? }`. 400 on missing/invalid `repo` or a non-positive `page`/`perPage`. Auth resolves exclusively through `resolveGitHubAuth` (FUSI-002); the token is never echoed.
- `GET /issues/filter-options?repo=` — `{ ok, repo, labels, milestones }` for the dropdowns. A missing-scope (401/403) label or milestone lookup degrades to an empty array rather than failing the whole request.

**Live-update seam** (`src/issues-events.ts`) — a tiny, dependency-free module-level pub/sub (`subscribeIssuesChanged`/`notifyIssuesChanged`; a `Set` of listeners, not a `window` DOM event, so it works cleanly under jsdom/SSR). `IssuesPanel` subscribes on mount and, on a matching-repo mutation notification, re-fetches its CURRENT page instead of a full reload. This is the seam FUSI-013 (issue detail), FUSI-014 (write ops), and FUSI-015 (inline label/assignee/milestone mutation) — none built yet — will call `notifyIssuesChanged` into once they land.

**`IssuesPanel` UI** (`src/IssuesPanel.tsx` / `IssuesPanel.css`):

- Filter bar: state (open/closed/all, default open), toggleable label chips, a free-text assignee input, a milestone select, a debounced (350ms) free-text search box, and a sort (created/updated/comments) + direction toggle. Any filter change resets to page 1.
- List rows: state badge, `#number`, clickable title (`onSelectIssue?(number)` prop stub for FUSI-013's later detail handoff, else links out to `htmlUrl`), label chips, assignee logins, comment count, relative updated-at.
- Pagination is strictly page-based — Prev/Next issue a fresh, page-scoped fetch; pages are never accumulated client-side, so a 10k+-issue repo never loads more than one page's rows. When the Search API's 1,000-result cap is reached, an explicit "showing the first ~1,000 matching results" notice renders instead of silently truncating.
- Distinct loading / empty ("no issues match these filters") / error (mapped message, never token text) / no-repo-selected ("select a repository") states. Zero labels/milestones render the dropdown with only its default "Any" option, not a broken empty shell.
- Styling uses design tokens only (`--space-*`, `--radius-*`, color/semantic tokens, `color-mix(...)` for label-color translucency); the filter bar and row layout reflow at the existing `@media (max-width: 48rem)` breakpoint.

`scripts/copy-css.mjs` now iterates a `CSS_FILES` list (`GitHubPmView.css`, `IssuesPanel.css`) rather than a single hardcoded src/dest pair, so this task's and future tasks' (e.g. FUSI-013's) CSS additions compose regardless of merge order.

## GitHub client (REST + GraphQL)

`src/github-client.ts` (FUSI-003) is a self-contained, portable GitHub API client — no `@fusion/core` or `gh`-CLI dependency in its hot path — built for eventual upstream submission.

```ts
import { GitHubClient } from "@fusion-plugin-examples/github-pm";

const client = new GitHubClient(token, fetch /* injectable fetch impl, defaults to global fetch */, {
  maxRetries: 3,     // default 3
  retryDelayMs: 1000, // default 1000ms fallback backoff when no Retry-After/x-ratelimit-reset header is present
});
```

- **REST pagination** — `listIssues(owner, repo, options)` follows the response `Link` header's `rel="next"` cursor (not a `page=` counter) via a generic `paginateRest` helper, so any list larger than GitHub's 100-item page ceiling is fully aggregated up to a caller-supplied `maxItems` bound.
- **GraphQL pagination** — `graphql<T>(query, variables)` posts to `https://api.github.com/graphql` and maps a top-level `errors[]` array to `GitHubApiError(code:"graphql_error")`. `listLabels(owner, repo, options)` demonstrates the bounded cursor-pagination helper (`paginateGraphQl`) over a `{ nodes, pageInfo { hasNextPage endCursor } }` connection, capped at 10 pages.
- **Throttling / back-off** — `fetchThrottled` retries on 403/429 responses that carry rate-limit signals (`Retry-After` header, or `x-ratelimit-remaining: 0` + `x-ratelimit-reset`), honoring the indicated wait interval up to `maxRetries` (default 3) before throwing `GitHubApiError(code:"rate_limited")`. A plain scope-denied 403 with no rate-limit headers is classified as `auth_error`, not retried.
- **Error codes** — `GitHubApiError` carries `status` and a discriminated `code`: `"auth_error" | "not_found" | "rate_limited" | "graphql_error" | "network_error" | "github_api_error"`. Use `isGitHubApiError(error)` to narrow and `githubErrorToResponse(error)` to map to an HTTP-response-shaped object (network errors report `status: 0` internally, surfaced as `502` by `githubErrorToResponse`).
- **Credential safety** — every thrown message is passed through `redactSensitiveText`, which strips the configured token and any `token=`/`key=`/`secret=`-shaped substrings before the error ever reaches a log, route response, or tool result.
- **Scope diagnostics primitive** — `getTokenScopes()` reads the `x-oauth-scopes` header from a cheap authenticated REST call and returns `{ scopes, hasScope(scope) }` so FUSI-002's diagnostics feature (e.g. detecting a missing `project` scope for Projects v2) can build on it directly; this module does not render any diagnostics UI itself.

All client behavior is covered by mocked-`fetch` unit tests in `src/__tests__/github-client.test.ts` — no real network calls, fake timers for backoff delays.

## Authentication (FUSI-002)

There is **no separate GitHub OAuth/login flow** anywhere in this plugin. `src/auth.ts` exports a single layered resolver, `resolveGitHubAuth`, that is the ONLY token-read entry point in the package — every route, tool, and the FUSI-003 GitHub client import it rather than reading `process.env.GITHUB_TOKEN` or shelling out to `gh` a second time. It tries, in this strict order:

1. **Personal access token (plugin setting) — highest precedence.** When the `personalAccessToken` setting is non-empty it is used as-is and OVERRIDES the sources below. This is deliberate: the PAT exists specifically so a user can grant *extra* scopes (for example `project`, required for Projects v2) beyond whatever an ambient `gh` CLI/env token already has. An override that could be silently outranked by auto-detected sources could not do that job.
2. **`GITHUB_TOKEN` environment variable.** Used when no PAT setting is configured.
3. **GitHub CLI (`gh`).** Used when `gh` is installed AND authenticated (`gh auth login`); the token is read via `gh auth token` through `@fusion/core`'s async gh helpers (`runGhAsync`) — never a synchronous shellout.
4. **None configured.** The resolver returns `{ authenticated: false, source: "none" }`. It never throws for this case, so callers always get a structured result.

The resolved token value is **never logged, echoed back in a route/tool response, or persisted** anywhere — only the `source` (`pat` / `env` / `gh-cli` / `none`) and derived scope/capability metadata are exposed.

### Scope diagnostics

After resolving a token, `auth.ts` issues exactly one authenticated request (`GET https://api.github.com/user`) and reads the `x-oauth-scopes` response header to determine which capabilities the token supports:

| Capability | Required scope (any of) |
| --- | --- |
| Issues | `repo`, `public_repo` |
| Discussions | `repo`, `public_repo` |
| Projects (v2) | `project`, `read:project` |

Token/response shapes are handled explicitly:

- **Classic PAT / OAuth token** — the `x-oauth-scopes` header is present and parsed; each capability reports `supported` or `missing`.
- **Fine-grained PAT or GitHub App token** — GitHub omits the `x-oauth-scopes` header entirely for these. This is *not* the same as "zero scopes": every capability reports `unknown` (not `missing`), and the diagnostics payload sets `introspectable: false` with an explanatory note. `project` is never falsely reported as missing for a token whose classic scopes simply cannot be read.
- **401 / invalid token** — reported as a distinct `auth-error` probe status, not a scope gap.
- **Network failure** — reported as `network-error`; the diagnostics panel degrades gracefully instead of crashing.

The probe result is cached for 60 seconds, keyed by a SHA-256 fingerprint of the token (never the raw token), so repeated diagnostics calls (panel mount, route hits, tool calls) don't repeatedly re-hit the GitHub API. `resetScopeProbeCache()` is exported for callers that need to force a fresh probe after settings change.

### Diagnostics route and panel

- `GET /auth/diagnostics` (plugin-scoped, under `/api/plugins/fusion-plugin-github-pm/`) returns `{ ok, authenticated, source, introspectable, probeStatus, capabilities, missingProjectScope, warning? }`. The token value is never included in the body.
- The `AuthDiagnosticsPanel` component (mounted in the GitHub PM dashboard view, `GitHubPmView.tsx`) fetches that route and renders:
  - The resolved auth source (for example "Authenticated via GitHub CLI").
  - Per-capability badges (Supported / Missing / Unknown) for issues, discussions, and projects.
  - When `missingProjectScope` is true: a clear, actionable warning box with step-by-step instructions to create/edit a PAT with the `project` scope and paste it into the plugin's `personalAccessToken` setting — the acceptance criterion this feature exists to satisfy (no silent failure).
  - When the token is non-introspectable (fine-grained PAT / GitHub App token): a note that classic scopes cannot be read, without claiming `project` is missing.
  - When not authenticated: guidance to run `gh auth login`, set `GITHUB_TOKEN`, or add a PAT — never a "Log in with GitHub" button.
  - When the diagnostics probe itself fails (network/route error): a degraded state that does not crash the rest of the dashboard view.

## Per-repo configuration storage (FUSI-004)

The plugin persists a durable, per-repo configuration map — last-selected repo, AI triage autonomy mode, approved taxonomy version, and view preferences — so switching between repos preserves each repo's own context, and the state survives a Fusion restart.

**Persistence mechanism.** Plugins have no bespoke KV/data-dir API. The durable store a plugin owns is its own settings blob in `central.plugin_installs.settings` (PostgreSQL-backed; see `packages/core/src/plugin-store.ts` `PluginStore.updatePluginSettings` and `packages/core/src/async-plugin-store.ts`). Because `PluginSettingType` has no object/json variant, the per-repo map is stored as a **serialized-JSON string setting** (`repoConfigState`) and the last selection as a plain **string setting** (`selectedRepo`). Both are plugin-managed — not intended for manual editing — and never contain secret/credential material; the PAT stays in its own `password` setting.

Decoding is corruption-tolerant by design: `src/repo-config.ts`'s `parseRepoConfigs` degrades undefined, non-string, empty-string, or malformed JSON to an empty map instead of throwing. `normalizeRepoKey` canonicalizes `owner/repo` identifiers (trim + lowercase both segments) so `Owner/Repo` and `owner/repo` resolve to the same entry, and rejects malformed input.

**Routes** (plugin-scoped under `/api/plugins/fusion-plugin-github-pm/*`, implemented in `src/repo-config-routes.ts`):

- `GET /repo-config` — read-only. Returns `{ ok, selectedRepo, config, repoConfigs }` derived entirely from `ctx.settings` (no writes).
- `PUT /repo-config` — body `{ repo, config }` (a partial `RepoConfig`). Validates `repo` via `normalizeRepoKey` (400 on invalid), merges the patch via `upsertRepoConfig`, and persists through `ctx.taskStore.getPluginStore().updatePluginSettings(ctx.pluginId, { repoConfigState: ... })`. Returns the resolved config for that repo.
- `PUT /repo-config/select` — body `{ repo }`. Validates `repo`, persists `selectedRepo`, and ensures a config row exists for that repo (defaults upserted if absent) in the **same** write, avoiding a second round-trip.

If `ctx.taskStore.getPluginStore` is unavailable, the write routes return `500 { code: "plugin_store_unavailable" }` instead of throwing.

See `src/repo-config.ts` for the domain module (`RepoConfig`, `RepoConfigMap`, `normalizeRepoKey`, `defaultRepoConfig`, `parseRepoConfigs`, `serializeRepoConfigs`, `resolveRepoConfig`, `upsertRepoConfig`) and `src/__tests__/repo-config.test.ts` / `src/__tests__/repo-config-routes.test.ts` for the corruption-tolerance, immutability, and configure-A/switch-B/return-to-A restart-survival coverage.

## Phase 1: Taxonomy proposal review (FUSI-005)

Given the currently selected repo, the plugin can analyze its real issue/discussion/label history and propose a bespoke, **repo-specific** label/field/category taxonomy. This is Phase 1 of the AI Structure-Generation & Classification milestone; **Phase 2 (classifying new issues/discussions into the accepted taxonomy) is explicitly out of scope for this feature.**

Four invariants hold everywhere in this feature (see the `FNXC:GithubPmTaxonomy` comments in `src/taxonomy-proposal.ts`, `src/taxonomy-store.ts`, and `src/taxonomy-routes.ts` for the full rationale):

1. **Data-driven** — the proposal is derived from `aggregateRepoSignal`'s summary of the repo's actual observed labels (with usage frequency), issue titles, and discussion categories/titles. There is no hardcoded default taxonomy anywhere in the module.
2. **Reviewable** — generating a proposal only ever creates a new **draft**; it is never applied automatically.
3. **Reversible** — proposals are versioned per repo (`nextProposalVersion` increments per repo); a bad draft can be rejected or superseded by a fresh `propose` call without losing history.
4. **No silent apply** — only the explicit **Accept** route can ever set `RepoConfig.approvedTaxonomyVersion` (the repo's active taxonomy). Propose, Edit, and Reject never touch it.

**Data source.** `src/github-client.ts`'s `listIssues`/`listLabels` (FUSI-003) plus a new `listDiscussions` GraphQL method (folding each discussion's category into the same query) supply the repo's history. `listDiscussions` degrades to `[]` — never throws — when the resolved token lacks discussion access (missing scope, or discussions disabled on the repo), so a repo whose token can't see discussions still gets a proposal from issues + labels alone.

**AI pass.** Generation flows exclusively through the engine-injected `ctx.createAiSession({ cwd, systemPrompt, tools: "readonly" })` factory (available on plugin **route** contexts only, not tool contexts) — the same seam used by `fusion-plugin-whatsapp-chat`. This is what makes the pass honor project `testMode`/mock and model-lane settings: no direct provider/model call exists anywhere in `src/taxonomy-proposal.ts`. When `ctx.createAiSession` is undefined (engine not loaded), `POST /taxonomy/propose` returns a typed `502 { code: "ai-unavailable" }` instead of throwing. An unparseable assistant response returns `502 { code: "parse-error" }`.

**Persistence.** Mirrors FUSI-004's pattern exactly: a per-repo map of proposal history is stored as a serialized-JSON string setting (`taxonomyProposalState`, `src/taxonomy-store.ts`), corruption-tolerant on read (`parseTaxonomyState` degrades undefined/malformed/non-object input to `{}`, never throws), with a stable sorted-key serialization for deterministic round-trips.

**Routes** (plugin-scoped under `/api/plugins/fusion-plugin-github-pm/*`, `src/taxonomy-routes.ts`):

- `POST /taxonomy/propose` — body `{ repo? }` (falls back to the selected repo). Fetches history via the resolved token (`resolveGitHubAuth`, FUSI-002), runs the AI pass, and appends a new **draft** version. Does **not** touch `approvedTaxonomyVersion`.
- `GET /taxonomy/proposals` — read-only. Query `?repo=` (or the selected repo). Returns `{ ok, repo, proposals, approvedTaxonomyVersion }`. No writes.
- `PUT /taxonomy/proposals/accept` — body `{ repo?, version }`. The **only** route that mutates the active taxonomy: marks the version accepted in the proposal store AND sets `RepoConfig.approvedTaxonomyVersion = version` via `upsertRepoConfig`, in a single atomic `updatePluginSettings` write.
- `PUT /taxonomy/proposals/reject` — body `{ repo?, version }`. Marks a version rejected. Does not change `approvedTaxonomyVersion`.
- `PUT /taxonomy/proposals/edit` — body `{ repo?, version, proposal }`. Replaces a draft's labels/fields/categories/rationale, keeps status `draft`. Refuses (`409 { code: "not_draft" }`) to edit an accepted/rejected version.

Every write route fails closed with `500 { code: "plugin_store_unavailable" }` when `ctx.taskStore.getPluginStore` is unavailable, and no route ever echoes the PAT/token.

**Dashboard panel.** `TaxonomyProposalPanel` (mounted once beneath `AuthDiagnosticsPanel` in `GitHubPmView.tsx`) reads the currently selected repo, offers a **Propose taxonomy** action (disabled with inline guidance when no repo is selected), and renders each proposal version with a status badge (Draft / Accepted / Rejected / **Active**) plus **Accept / Reject / Edit** controls — the controls are only rendered for draft proposals, so no orphaned button shells remain once a proposal is accepted or rejected.

**Restart durability.** Because both the taxonomy-proposal state and the repo-config's `approvedTaxonomyVersion` live in the same durable settings blob (`central.plugin_installs.settings`), an accepted taxonomy version survives a Fusion restart — verified by `src/__tests__/taxonomy-routes.test.ts`'s restart-survival test, which rebuilds a fresh `ctx` from only the captured settings blob.

## Issue detail: markdown body, comments, timeline (FUSI-013)

The read side of the Issues slice: a full issue detail surface built on three new read-only `GitHubClient` methods, two plugin routes, and a self-contained `IssueDetailView` component. This is deliberately additive and does **not** touch `GitHubPmView.tsx` (its tabbed-shell refactor is in-flight in FUSI-008); `IssueDetailView` exposes a `{ context, repo, issueNumber, onBack? }` prop seam for FUSI-008/FUSI-012 to mount later.

**Client methods** (`src/github-client.ts`):

- `getIssue(owner, repo, number)` — `GET /repos/{owner}/{repo}/issues/{number}`, mapped to `GitHubIssueDetail` (`bodyMarkdown`, `state`, `author`, `labels` with `color`, `assignees`, `milestone`, `commentCount`). Rejects a `pull_request`-shaped payload with a `not_found`-style `GitHubApiError` — this surface is issues-only.
- `listIssueComments(owner, repo, number, { page?, perPage? })` — `GET .../comments`, returning **one page at a time** as `{ comments, nextPage }`; `nextPage` is derived from the REST `Link: rel="next"` header's `page` query value (`null` when absent). Comments are never eagerly accumulated across pages.
- `listIssueTimeline(owner, repo, number, { maxItems? })` — paginates `GET .../timeline` via the existing `paginateRest` helper, then filters to the key events the detail view renders: `closed`, `reopened`, `labeled`, `unlabeled`, `referenced`, `cross-referenced`. Other event types (commented, assigned, renamed, …) are dropped.

**Routes** (plugin-scoped, read-only, no plugin-store writes):

- `GET /issues/detail?repo=&number=` — bundles `getIssue` + `listIssueTimeline` + the first comment page in one round trip: `{ ok, repo, issue, timeline, comments, commentsNextPage }`. `repo` falls back to the selected repo when omitted; 400 on a missing/invalid `repo` or non-positive `number`.
- `GET /issues/comments?repo=&number=&page=` — subsequent comment pages for lazy loading: `{ ok, repo, comments, nextPage }` (default `page=1`).

Both routes resolve auth via `resolveGitHubAuth` (never a second token-read path) and map `GitHubApiError` through `githubErrorToResponse`; the token value is never echoed in a response body.

**`IssueDetailView`** (`src/IssueDetailView.tsx` + `IssueDetailView.css`) renders on mount: a header (title, `#number`, open/closed state badge, external GitHub link, optional back affordance), the markdown body via `react-markdown` + `remark-gfm` (code blocks, images, GFM task lists — falling back to "No description provided." for an empty body), a metadata sidebar (state, author, labels-as-color chips, assignees, milestone — each section omitted, not rendered as an empty shell, when absent), a comment thread with a "Load more comments" button that fetches `GET /issues/comments` until `nextPage` is `null` (then the button is removed, not disabled — and never rendered at all for a zero-comment issue), and the key timeline events. Reflows to a single column at the existing `@media (max-width: 48rem)` breakpoint. Never renders the PAT/token value.

## Setup

1. Install or enable **GitHub PM** from Settings → Plugins / Plugin Manager.
2. Optionally open the plugin settings and set a default repository (`owner/repo`) and default triage autonomy.
3. To use `gh` CLI auth, run `gh auth login` once outside Fusion; to use the env var, set `GITHUB_TOKEN` in the environment Fusion runs in. To add scopes beyond either of those (for example `project` for Projects v2), generate a personal access token at <https://github.com/settings/tokens> and paste it into the plugin's "GitHub personal access token" setting — it overrides the other two sources.
4. Open the **GitHub PM** dashboard view. It shows the settings-presence status badge plus the Authentication diagnostics panel described above, without ever displaying the PAT value.

## Settings schema

| Key | Type | Group | Notes |
| --- | --- | --- | --- |
| `personalAccessToken` | `password` | Authentication | Optional PAT override; highest-precedence auth source; never echoed back in route responses, tool results, or logs. |
| `defaultRepo` | `string` | Defaults | `owner/repo` hint for the future repo picker (FUSI-004). |
| `defaultAutonomy` | `enum` (`approve-all` \| `suggest` \| `auto`) | Defaults | Default AI triage autonomy level; defaults to `approve-all`. |
| `selectedRepo` | `string` | Repositories | Plugin-managed last-selected repo (`owner/repo`, canonicalized). Written by the repo-config select route; not hand-edited. |
| `repoConfigState` | `string` (multiline) | Repositories | Plugin-managed serialized-JSON `RepoConfigMap`. Written by the repo-config routes; not hand-edited. |
| `taxonomyProposalState` | `string` (multiline) | Repositories | Plugin-managed serialized-JSON `TaxonomyProposalStateMap` (FUSI-005). Written by the taxonomy routes; not hand-edited. |

## Routes

Plugin-scoped under `/api/plugins/fusion-plugin-github-pm/*`:

- `GET /status` — reports `{ ok, configured, autonomy, defaultRepo }` derived solely from settings presence. Does **not** call the GitHub API and does **not** echo the PAT.
- `GET /auth/diagnostics` — resolves the layered auth chain and returns per-capability scope diagnostics (see above). Does **not** return the resolved token/PAT value.
- `GET /repo-config`, `PUT /repo-config`, `PUT /repo-config/select` — per-repo configuration storage (FUSI-004); see the section above.
- `POST /taxonomy/propose`, `GET /taxonomy/proposals`, `PUT /taxonomy/proposals/accept`, `PUT /taxonomy/proposals/reject`, `PUT /taxonomy/proposals/edit` — versioned, reviewable taxonomy proposal generation (FUSI-005); see the section above.
- `GET /issues/detail`, `GET /issues/comments` — read-only issue detail, timeline, and paginated comments (FUSI-013); see the section above.
- `GET /issues/list`, `GET /issues/filter-options` — issue list/search/filter-dropdown reads (FUSI-012); see the section above.

## Agent tools

- `github_pm_status` — returns configured/not-configured text derived from settings, exercising tool registration ahead of real issue-management tools landing in later milestone tasks.

## Limitations and non-goals (FUSI-001/FUSI-002)

- No live GitHub REST/GraphQL calls beyond the single scope-probe request described above.
- No host-owned `/api/github-pm/*` routes or core GitHub PM settings.
- No repo picker UI yet; the per-repo config storage layer (FUSI-004) is the persistence foundation later picker/triage features build on.
- No separate GitHub OAuth/login flow, and none will be added — auth layers exclusively on `gh` CLI / `GITHUB_TOKEN` / PAT setting.

## External Integration Evidence

This plugin integrates the GitHub REST + GraphQL API (consumed as a SaaS HTTP API; no downloaded binary is added by this plugin) and, optionally, the `gh` CLI for auth detection. FUSI-005 adds one more GraphQL surface, `repository.discussions` (consumed via the client's existing `graphql<T>()` method; see <https://docs.github.com/en/graphql/reference/objects#repository> and <https://docs.github.com/en/graphql/reference/objects#discussion>), for taxonomy-proposal history aggregation. No new CLI/binary/daemon is added by this feature.

- Canonical upstream repo URL: <https://github.com/cli/cli> (`gh` CLI, used by the layered auth resolver when installed and authenticated)
- Docs / homepage URL: <https://docs.github.com/en/rest> and <https://docs.github.com/en/graphql>
- Release / download URL: `upstream-pending-verification` (no downloadable binary added by this plugin; `gh` install is out of scope — the resolver only reads an existing `gh auth token`)
- Binary / CLI name: `gh` (invoked via `@fusion/core`'s async `runGhAsync`, never a synchronous shellout)
- Checksum: `upstream-pending-verification` (no binary downloaded by this plugin)
