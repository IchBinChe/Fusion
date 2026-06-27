---
"@runfusion/fusion": minor
---

summary: Reject malformed workflow graphs before they can be saved or launched.
category: feature
dev: Hardens the central parseWorkflowIr/validateV2 gate (duplicate-node-id and required top-level reachability rejection) and fail-closed re-validation at the WorkflowGraphTaskRunner run boundary before any side effects (FN-7113).
