---
"@runfusion/fusion": patch
---

summary: The task Workflow tab now shows the configured project Executor/Reviewer/Planning model instead of "Default".
category: fix
dev: Task-detail model display now overlays the task's effective workflow setting values (where the moved per-phase model lanes live) onto getSettingsFast() via a shared core applyWorkflowSettingsOverlay helper and a new GET /api/tasks/:id/effective-settings endpoint. Engine mergeEffectiveSettings reuses the same helper unchanged. FN-7123.
