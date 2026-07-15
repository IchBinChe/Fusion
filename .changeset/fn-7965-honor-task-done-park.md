---
"@runfusion/fusion": patch
---

summary: Tasks parked by a refused fn_task_done no longer resurrect and strand at code review.
category: fix
dev: FN-7965. `fn_task_done`'s in-session refusal handler parks the row terminally (status=failed, worktree/branch/sessionFile cleared) once `MAX_TASK_DONE_REQUEUE_RETRIES` is exhausted, but the executor's no-fn_task_done retry loop never observed that park and spawned a fresh session. That session completed and marked the task done against a worktree-less row, so the pre-merge graph failed on the first write-capable node (`no-worktree-for-write-node`) and surfaced as a misleading "Workflow graph terminated with failure at node 'code-review-remediation'". The loop now re-reads state and honors the park (`terminallyParked`), stopping without requeue or review handoff — deliberately not routed through the FN-4806 reclaim branch, whose silent todo requeue would clear the park and re-park on next pickup in a todo→execute→park loop. The pre-existing reclaim probes could not catch this: they test `worktree === null`, but the store maps a cleared column to `undefined` (`task-store/serialization.ts` — `row.worktree || undefined`); tightening that probe is left as separate work.
