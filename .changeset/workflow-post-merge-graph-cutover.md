---
"@runfusion/fusion": patch
---

summary: Post-merge workflow steps now run once via the workflow graph instead of the merger.
category: internal
dev: Flips `experimentalFeatures.graphNativePostMerge` DEFAULT-ON so the graph is the sole post-merge owner; the legacy merger post-merge path (`runPostMergeWorkflowSteps`/`hasEnabledPostMergeWorkflowSteps`) is inert under the flag (kept until U7c). DB migration 130 rewrites legacy compiled `workflow_steps` enable ids (templateId ∈ built-in optional-group ids: browser-verification, code-review) to the graph node ids in tasks' `enabledWorkflowSteps` (idempotent, de-duped). `workflow_steps` table is retained.
