---
"@runfusion/fusion": patch
---

summary: The planner overseer now notices a failed in-progress task immediately instead of after two hours.
category: fix
dev: FN-7965. `deriveSignalAndSources`'s `executor` branch never read `task.status`, so a row parked `status: "failed"` (e.g. the terminal fn_task_done refusal/invariant park) reported `signal: "progressing"` with reason "Task is actively executing in-progress work". `failed` was only ever derived for the merger/pull-request stages, leaving the FN-7743 2h stall proxy (`columnMovedAt ?? updatedAt`) as the sole backstop. The branch now reports `failed`, which routes into the pre-existing failed-signal policy — `retry_step` at executor stage (sources are `agent-log`, never an ERROR_SOURCE_KIND), bounded by `PLANNER_RECOVERY_MAX_ATTEMPTS` and escalated on exhaustion. `paused` keeps precedence (operator/user-paused stays `blocked`), the reason is held constant so the FN-7577 `stage|signal|reason` feed dedup still holds, and `status` was added to `OverseerTaskRef`.
