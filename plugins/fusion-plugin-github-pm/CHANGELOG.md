# @fusion-plugin-examples/github-pm

## Unreleased

### Milestone management screen (KB-003)

- `GitHubClient.listMilestones` gains an additive shape and options object: `openIssues`/`closedIssues` (always numbers), `description`, `dueOn`, `htmlUrl`, `createdAt`, `updatedAt`, `closedAt`, plus `{ state?, sort?, direction? }`. The original `number`/`title`/`state` fields the issues-filter dropdown consumes are unchanged.
- New client write methods: `createMilestone`, `updateMilestone`, `setMilestoneState` (close/reopen), `deleteMilestone` (204-tolerant), `listOpenIssuesForMilestone`, and `setIssueMilestone` (clear/move a single issue's milestone).
- New `src/milestone-routes.ts`: `GET /milestones/list`, `POST /milestones/create`, `PUT /milestones/update`, `PUT /milestones/state`, `POST /milestones/delete`, `POST /milestones/reassign-open-issues` — all writes gated by the existing `confirmWrites` contract, checked before auth resolution.
- New agent tools: `github_pm_create_milestone`, `github_pm_update_milestone`, `github_pm_set_milestone_state`, `github_pm_delete_milestone`.
- New `MilestonesPanel` component (list with progress bars matching GitHub's `closed/(open+closed)` ratio, overdue flags for open past-due milestones, create/edit/close/reopen/delete, and a close-with-open-issues prompt offering keep/clear/move) mounted into the `milestones` tabpanel of `GitHubPmView.tsx`, replacing its placeholder.
- `scripts/copy-css.mjs` now also copies `IssueWritePanel.css` (a pre-existing gap) and `MilestonesPanel.css`.

### Issue detail view with comments and timeline (FUSI-013)

- `GitHubClient` gains three read-only issue-detail methods: `getIssue` (full issue detail, rejects PR-shaped payloads), `listIssueComments` (page-at-a-time, derives `nextPage` from the `Link` header — lazy-loads by design), and `listIssueTimeline` (filtered to closed/reopened/labeled/unlabeled/referenced/cross-referenced key events).
- Two new read-only plugin routes, `GET /issues/detail` and `GET /issues/comments`, registered onto `githubPmRoutes`; both resolve auth via `resolveGitHubAuth` and never echo the token.
- New `IssueDetailView` component renders the full issue: GFM markdown body (code blocks, images, task lists) via `react-markdown`/`remark-gfm`, a metadata sidebar (state/author/labels/assignees/milestone, empty sections omitted), a lazily-paginating comment thread ("Load more comments" until exhausted), and key timeline events. Mounts via a `{ context, repo, issueNumber, onBack? }` prop seam for FUSI-008/FUSI-012 to attach later; `GitHubPmView.tsx` is untouched.
- `scripts/copy-css.mjs` now copies every plugin component CSS file (`GitHubPmView.css`, `IssueDetailView.css`) into `dist/`.

### Issue list with filters and search (FUSI-012)

- New read-only `GitHubClient` methods: `listIssuesPage` (single-page REST issues-list read with state/labels/assignee/milestone/sort/direction/page/perPage — the same query params GitHub's own issues-list UI uses), `searchIssues` (GitHub Search API, used only when a free-text term is present, surfacing the API's 1,000-result cap via `cappedAtLimit` rather than silently truncating), and `listMilestones` (bounded lookup for the filter dropdown). `listIssues`'s existing accumulate-all contract (depended on by the taxonomy proposal aggregator) is unchanged.
- New routes `GET /issues/list` (dispatches to the plain list path or the search path based on whether `search` is present) and `GET /issues/filter-options` (labels + milestones for the dropdowns), registered on `githubPmRoutes`.
- New plugin-local refresh signal (`src/issues-events.ts`: `subscribeIssuesChanged`/`notifyIssuesChanged`) that later write-operation tasks (FUSI-013/014/015) will notify into so a rendered list re-fetches its current page without a full reload.
- New `IssuesPanel` component (state/label/assignee/milestone/search filters, sort + direction, page-based non-accumulating pagination, capped-results notice) mounted into the `issues` tabpanel of `GitHubPmView.tsx`, replacing its placeholder — the shell's other five tabs, tablist, repo-context header, and `AuthDiagnosticsPanel` are unchanged.
- `scripts/copy-css.mjs` now copies a list of CSS files (`GitHubPmView.css`, `IssuesPanel.css`) instead of a single hardcoded pair.

### Tabbed dashboard view shell (FUSI-008)

- `GitHubPmView` is now a durable view shell: a repo-context header (reading the persisted selection via `GET /repo-config`, itself built from FUSI-004's `resolveSelectedRepo`) plus an accessible, token-styled tab bar (`GitHubPmTabs.tsx`) for the six declared Foundation-milestone surfaces (Issues, Labels, Milestones, Discussions, Projects, Triage).
- Tab panels stay mounted (toggled via the `hidden` attribute) so per-tab local state survives a switch-away-and-back; each placeholder panel names the task that will fill it.
- The tab-bar shape carries a `disabled`/`disabledReason` seam for FUSI-009's capability gating and a repo-picker mount slot for FUSI-007, without implementing either behavior here.
- The existing settings-presence status badge and `AuthDiagnosticsPanel` (FUSI-002) continue to render unchanged, relocated into the shell.

## 0.1.0

### Initial scaffold

- Plugin scaffold: manifest, settings schema (`personalAccessToken`, `defaultRepo`, `defaultAutonomy`), a plugin-owned `/status` route, a placeholder `github_pm_status` tool, and a lazy-loaded dashboard view.
- No live GitHub API calls yet. Layered auth resolver lands in FUSI-002, the REST/GraphQL client in FUSI-003, and per-repo configuration storage in FUSI-004.
