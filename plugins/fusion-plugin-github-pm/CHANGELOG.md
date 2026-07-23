# @fusion-plugin-examples/github-pm

## 0.1.0

### Initial scaffold

- Plugin scaffold: manifest, settings schema (`personalAccessToken`, `defaultRepo`, `defaultAutonomy`), a plugin-owned `/status` route, a placeholder `github_pm_status` tool, and a lazy-loaded dashboard view.
- No live GitHub API calls yet. Layered auth resolver lands in FUSI-002, the REST/GraphQL client in FUSI-003, and per-repo configuration storage in FUSI-004.
