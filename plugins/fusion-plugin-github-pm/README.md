# GitHub PM Plugin

`fusion-plugin-github-pm` is a bundled Fusion integration plugin scaffold for general-purpose, GitHub-native project management: issues, discussions, Projects v2 boards, labels, and milestones for any repository, from inside Fusion. It follows the `fusion-plugin-linear-import` pattern — plugin-owned settings, routes, tools, and a dashboard view, not host-owned `/api/github-pm/*` routes or core GitHub PM settings.

## Scaffold scope (this task, FUSI-001)

This package currently ships **only the skeleton**:

- `manifest.json` with a `settingsSchema` declaring the setting keys downstream tasks will consume (`personalAccessToken`, `defaultRepo`, `defaultAutonomy`) and a `dashboardViews` entry.
- A plugin-owned `GET /status` route that reports `{ ok, configured, autonomy, defaultRepo }` derived only from settings presence — no GitHub API calls.
- A placeholder `github_pm_status` agent tool.
- A placeholder dashboard view stating the full surface (repo picker, issue management) is coming online.

**Not implemented yet** (deliberately out of scope for this task):

- The layered GitHub auth resolver (`gh` CLI → `GITHUB_TOKEN` → PAT override) and scope diagnostics — lands in FUSI-002.
- Per-repo configuration storage and the any-repo picker — lands in FUSI-004.
- The dashboard view, routes, and tools do not call the GitHub client yet — that wiring lands in later slices once the auth resolver (FUSI-002) can supply a token.

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

## Setup

1. Install or enable **GitHub PM** from Settings → Plugins / Plugin Manager.
2. Optionally open the plugin settings and set a default repository (`owner/repo`) and default triage autonomy.
3. Optionally set a personal access token override for scopes the layered auth resolver in FUSI-002 will need (e.g. `project` for Projects v2). Leaving it blank is fine — auth falls back to the `gh` CLI or `GITHUB_TOKEN` in later milestone tasks.
4. Open the **GitHub PM** dashboard view. On a fresh install with no settings configured it renders a "not configured" placeholder; once `personalAccessToken` or `defaultRepo` is set it renders "configured", without ever displaying the PAT value.

## Settings schema

| Key | Type | Group | Notes |
| --- | --- | --- | --- |
| `personalAccessToken` | `password` | Authentication | Optional PAT override; never echoed back in route responses, tool results, or logs. |
| `defaultRepo` | `string` | Defaults | `owner/repo` hint for the future repo picker (FUSI-004). |
| `defaultAutonomy` | `enum` (`approve-all` \| `suggest` \| `auto`) | Defaults | Default AI triage autonomy level; defaults to `approve-all`. |

## Routes

Plugin-scoped under `/api/plugins/fusion-plugin-github-pm/*`:

- `GET /status` — reports `{ ok, configured, autonomy, defaultRepo }` derived solely from settings presence. Does **not** call the GitHub API and does **not** echo the PAT.

## Agent tools

- `github_pm_status` — returns configured/not-configured text derived from settings, exercising tool registration ahead of real issue-management tools landing in later milestone tasks.

## Limitations and non-goals (this task)

- No live GitHub REST/GraphQL calls.
- No `gh` CLI invocation.
- No host-owned `/api/github-pm/*` routes or core GitHub PM settings.
- No repo picker; `defaultRepo` is a plain string setting only.

## External Integration Evidence

This plugin will integrate the GitHub REST + GraphQL API (consumed as a SaaS HTTP API; no downloaded binary is added in this scaffold task). The layered auth resolver in FUSI-002 uses the `gh` CLI when present.

- Canonical upstream repo URL: <https://github.com/cli/cli> (`gh` CLI, used by the FUSI-002 auth layer; not invoked in this scaffold)
- Docs / homepage URL: <https://docs.github.com/en/rest> and <https://docs.github.com/en/graphql>
- Release / download URL: `upstream-pending-verification` (no downloadable binary added in this task; `gh` install is out of scope for the scaffold)
- Binary / CLI name: `gh` (referenced by FUSI-002 auth resolver only; not spawned here)
- Checksum: `upstream-pending-verification` (no binary downloaded in this task)
