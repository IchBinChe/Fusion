---
"@runfusion/fusion": minor
---

summary: Permanent/custom agents can use governed workflow and task-promotion tools.
category: feature
dev: Injects the FN-7111-classified mutating tools (fn_workflow_create/update/delete/settings/select, fn_task_promote) into the heartbeat agent-work lane (packages/engine/src/agent-heartbeat.ts), governed by AgentPermissionPolicy via wrapToolsWithActionGate. Executor-only tools requiring worktree/workspace context (fn_run_verification, fn_acquire_repo_worktree) remain intentionally excluded from the ambient lane. Hermetic readonly lanes and automation allowedTools are unchanged.
