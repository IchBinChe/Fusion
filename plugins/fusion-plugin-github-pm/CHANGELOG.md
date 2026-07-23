# @fusion-plugin-examples/github-pm

## Unreleased

### Tabbed dashboard view shell (FUSI-008)

- `GitHubPmView` is now a durable view shell: a repo-context header (reading the persisted selection via `GET /repo-config`, itself built from FUSI-004's `resolveSelectedRepo`) plus an accessible, token-styled tab bar (`GitHubPmTabs.tsx`) for the six declared Foundation-milestone surfaces (Issues, Labels, Milestones, Discussions, Projects, Triage).
- Tab panels stay mounted (toggled via the `hidden` attribute) so per-tab local state survives a switch-away-and-back; each placeholder panel names the task that will fill it.
- The tab-bar shape carries a `disabled`/`disabledReason` seam for FUSI-009's capability gating and a repo-picker mount slot for FUSI-007, without implementing either behavior here.
- The existing settings-presence status badge and `AuthDiagnosticsPanel` (FUSI-002) continue to render unchanged, relocated into the shell.

## 0.1.0

### Initial scaffold

- Plugin scaffold: manifest, settings schema (`personalAccessToken`, `defaultRepo`, `defaultAutonomy`), a plugin-owned `/status` route, a placeholder `github_pm_status` tool, and a lazy-loaded dashboard view.
- No live GitHub API calls yet. Layered auth resolver lands in FUSI-002, the REST/GraphQL client in FUSI-003, and per-repo configuration storage in FUSI-004.
