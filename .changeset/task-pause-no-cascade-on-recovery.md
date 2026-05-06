---
"@runfusion/fusion": patch
---

Stop inadvertently pausing user-facing tasks during heartbeat-unresponsive
recovery. Adds a `cascadeToTasks` option to `pauseAgent`/`resumeAgent`
(default `true`) and passes `false` from `recoverUnresponsiveAgent` — the
internal pause/resume cycle there is just to set
`pauseReason="heartbeat-unresponsive"` on the agent and shouldn't toggle
the user's task pause state.

Also auto-clears `paused`/`pausedByAgentId` in `updateTask` when the agent
that paused a task is unassigned (or replaced). Previously a task could be
left orphaned-paused with no UI affordance to recover, since the
`Pause/Unpause` action in `TaskDetailModal` is hidden whenever an agent is
assigned.
