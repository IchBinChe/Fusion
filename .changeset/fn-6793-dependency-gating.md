---
"@runfusion/fusion": patch
---

Fix dependency gating so workflow-graph and workflow-authoritative executor dispatches re-check unmet task dependencies before running, requeueing blocked work with `blockedBy` instead of allowing it to advance to review.

Add self-healing reconciliation for already-advanced `in-review` tasks with unmet dependencies, including the `task:reconcile-in-review-unmet-dependencies` run-audit event and guarded no-action companion.
