---
"@runfusion/fusion": patch
---

summary: Fix tasks looping through triage at the completion-summary node, plus Stats/Routing/Node labels crashing.
category: fix
dev: Issue #1863 (v0.52.0 regression). (1) The best-effort completion-summary graph node is wired with a success-only edge, so a thrown handler exception or a failed summary projection write terminated the graph and the in-review→todo resume router bounced the task forever. The graph executor now degrades a completion-summary node failure to success (ensureWorkflowCompletionSummary still backfills task.summary), with a routeGraphFailureToExecutionResume backstop. (2) Three views called t() with keys that resolve to nested objects (taskDetail.executionMode, routing.source, nodes.dockerHost); added leaf label keys across all locales and a dashboard invariant test that scans t("literal") callers against the real en/app.json.
