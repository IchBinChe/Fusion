# @fusion-plugin-examples/github-pm

## Unreleased

### Issue detail view with comments and timeline (FUSI-013)

- `GitHubClient` gains three read-only issue-detail methods: `getIssue` (full issue detail, rejects PR-shaped payloads), `listIssueComments` (page-at-a-time, derives `nextPage` from the `Link` header — lazy-loads by design), and `listIssueTimeline` (filtered to closed/reopened/labeled/unlabeled/referenced/cross-referenced key events).
- Two new read-only plugin routes, `GET /issues/detail` and `GET /issues/comments`, registered onto `githubPmRoutes`; both resolve auth via `resolveGitHubAuth` and never echo the token.
- New `IssueDetailView` component renders the full issue: GFM markdown body (code blocks, images, task lists) via `react-markdown`/`remark-gfm`, a metadata sidebar (state/author/labels/assignees/milestone, empty sections omitted), a lazily-paginating comment thread ("Load more comments" until exhausted), and key timeline events. Mounts via a `{ context, repo, issueNumber, onBack? }` prop seam for FUSI-008/FUSI-012 to attach later; `GitHubPmView.tsx` is untouched.
- `scripts/copy-css.mjs` now copies every plugin component CSS file (`GitHubPmView.css`, `IssueDetailView.css`) into `dist/`.

### Tabbed dashboard view shell (FUSI-008)

- `GitHubPmView` is now a durable view shell: a repo-context header (reading the persisted selection via `GET /repo-config`, itself built from FUSI-004's `resolveSelectedRepo`) plus an accessible, token-styled tab bar (`GitHubPmTabs.tsx`) for the six declared Foundation-milestone surfaces (Issues, Labels, Milestones, Discussions, Projects, Triage).
- Tab panels stay mounted (toggled via the `hidden` attribute) so per-tab local state survives a switch-away-and-back; each placeholder panel names the task that will fill it.
- The tab-bar shape carries a `disabled`/`disabledReason` seam for FUSI-009's capability gating and a repo-picker mount slot for FUSI-007, without implementing either behavior here.
- The existing settings-presence status badge and `AuthDiagnosticsPanel` (FUSI-002) continue to render unchanged, relocated into the shell.

## 0.1.0

### Initial scaffold

- Plugin scaffold: manifest, settings schema (`personalAccessToken`, `defaultRepo`, `defaultAutonomy`), a plugin-owned `/status` route, a placeholder `github_pm_status` tool, and a lazy-loaded dashboard view.
- No live GitHub API calls yet. Layered auth resolver lands in FUSI-002, the REST/GraphQL client in FUSI-003, and per-repo configuration storage in FUSI-004.
