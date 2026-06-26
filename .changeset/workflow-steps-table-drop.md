---
"@runfusion/fusion": patch
---

summary: Retire the legacy workflow-steps store; workflow steps now run entirely graph-native.
category: internal
dev: U7c removes the last readers/writers of the legacy `workflow_steps` table and drops it via migration 131 (SCHEMA_VERSION 130→131, idempotent DROP). Removed: store CRUD (`create`/`update`/`delete`/`getWorkflowStep`), the workflow-compilation materializer (`materializeWorkflowSteps`), `migrateLegacyWorkflowSteps` + its `POST /api/workflows/migrate-legacy-steps` route and the editor's on-open migration notice, and the merger legacy post-merge execution path (worktree + prompt/script step run). Pre/post-merge steps record into `task.workflowStepResults`; `selectTaskWorkflow` now seeds `enabledWorkflowSteps` with default-on optional-group node ids only (the graph runs the workflow IR directly). `listWorkflowSteps()` returns only the in-memory plugin palette. Executor revive sources gate-ness from the recorded result status, not the table.
