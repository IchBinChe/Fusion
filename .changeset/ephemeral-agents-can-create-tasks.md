---
"@runfusion/fusion": minor
---

summary: Add a project setting to allow or block ephemeral agents from creating tasks (default on).
category: feature
dev: New project setting `ephemeralAgentsCanCreateTasks` (default true) in DEFAULT_PROJECT_SETTINGS; gated in both fn_task_create surfaces (pi extension caller-agent check and the engine executor's ephemeral task-worker tool via `AgentTaskCreationOptions.callerIsEphemeral`). Toggle lives in Settings → General.
