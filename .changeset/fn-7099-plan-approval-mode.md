---
"@runfusion/fusion": minor
---

summary: Add a per-project plan-approval mode to auto-approve or require approval for all tasks.
category: feature
dev: New project setting `planApprovalMode` ("workflow" | "auto-approve-all" | "require-all"); overrides the per-workflow `requirePlanApproval` via `resolvePlanApprovalRequired` at the triage gating sites.
