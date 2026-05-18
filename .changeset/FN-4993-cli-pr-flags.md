---
"@runfusion/fusion": patch
---

`fn pr create` (and the `fn task pr-create` alias) now support `--draft`, `--no-ai`, and repeatable `--reviewer <login>` flags. Adds a top-level `fn pr` subcommand router. When `--no-ai` is not set, the CLI now reuses the dashboard's AI metadata pipeline to generate the PR title/body — parity with the dashboard `PrCreateModal`. `GitHubClient.createPr` accepts `draft` and `reviewers`.
