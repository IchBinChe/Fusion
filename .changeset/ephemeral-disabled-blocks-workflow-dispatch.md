---
"@runfusion/fusion": patch
---

summary: Disabling ephemeral agents now also stops the workflow engine from running unassigned tasks.
category: fix
dev: Added `TaskExecutor.blockOuterDispatchWhenEphemeralDisabled` gate at the top of `execute()`, ahead of all three workflow dispatch paths (maybeExecuteWorkflowGraph, workflowAuthoritativeDispatch, maybeDispatchWorkflowWorkEngine). Previously `ephemeralAgentsEnabled=false` was enforced only on the legacy scheduler/EphemeralWorkerManager path; the workflow-engine paths ran unassigned tasks anyway because the spawn refusal is a post-execution fire-and-forget callback. Unassigned tasks are now re-queued for permanent-agent assignment; tasks bound to a permanent agent still run.
