# GitHub PM Plugin

`fusion-plugin-github-pm` is a bundled Fusion integration plugin for general-purpose, GitHub-native project management: issues, discussions, Projects v2 boards, labels, and milestones for any repository, from inside Fusion. It follows the `fusion-plugin-linear-import` pattern — plugin-owned settings, routes, tools, and a dashboard view, not host-owned `/api/github-pm/*` routes or core GitHub PM settings.

## Scaffold scope (FUSI-001)

This package ships the skeleton:

- `manifest.json` with a `settingsSchema` declaring the setting keys (`personalAccessToken`, `defaultRepo`, `defaultAutonomy`) and a `dashboardViews` entry.
- A plugin-owned `GET /status` route that reports `{ ok, configured, autonomy, defaultRepo }` derived only from settings presence — no GitHub API calls.
- A placeholder `github_pm_status` agent tool.
- A dashboard view showing configuration status and (as of FUSI-002) the authentication diagnostics panel described below.

**Not implemented yet** (deliberately out of scope for FUSI-001/FUSI-002):

- Per-repo configuration storage and the any-repo picker — lands in FUSI-004.
- Live issue/discussion/Projects v2/label/milestone CRUD — later Foundation-milestone tasks.
- The dashboard view, routes, and tools do not call the GitHub client yet — that wiring lands in later slices now that both the auth resolver (FUSI-002) and the GitHub client (FUSI-003) can supply/consume a token.

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

## Routes

Plugin-scoped under `/api/plugins/fusion-plugin-github-pm/*`:

- `GET /status` — reports `{ ok, configured, autonomy, defaultRepo }` derived solely from settings presence. Does **not** call the GitHub API and does **not** echo the PAT.
- `GET /auth/diagnostics` — resolves the layered auth chain and returns per-capability scope diagnostics (see above). Does **not** return the resolved token/PAT value.

## Agent tools

- `github_pm_status` — returns configured/not-configured text derived from settings, exercising tool registration ahead of real issue-management tools landing in later milestone tasks.

## Limitations and non-goals (FUSI-001/FUSI-002)

- No live GitHub REST/GraphQL calls beyond the single scope-probe request described above.
- No host-owned `/api/github-pm/*` routes or core GitHub PM settings.
- No repo picker; `defaultRepo` is a plain string setting only.
- No separate GitHub OAuth/login flow, and none will be added — auth layers exclusively on `gh` CLI / `GITHUB_TOKEN` / PAT setting.

## External Integration Evidence

This plugin integrates the GitHub REST + GraphQL API (consumed as a SaaS HTTP API; no downloaded binary is added by this plugin) and, optionally, the `gh` CLI for auth detection.

- Canonical upstream repo URL: <https://github.com/cli/cli> (`gh` CLI, used by the layered auth resolver when installed and authenticated)
- Docs / homepage URL: <https://docs.github.com/en/rest> and <https://docs.github.com/en/graphql>
- Release / download URL: `upstream-pending-verification` (no downloadable binary added by this plugin; `gh` install is out of scope — the resolver only reads an existing `gh auth token`)
- Binary / CLI name: `gh` (invoked via `@fusion/core`'s async `runGhAsync`, never a synchronous shellout)
- Checksum: `upstream-pending-verification` (no binary downloaded by this plugin)
