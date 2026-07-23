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
- The plugin-owned REST + GraphQL GitHub client with throttling and pagination — lands in FUSI-003.
- Per-repo configuration storage and the any-repo picker — lands in FUSI-004.
- No live GitHub API call is made anywhere in this package yet.

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
