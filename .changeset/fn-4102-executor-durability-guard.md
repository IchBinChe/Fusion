---
"@runfusion/fusion": patch
---

Add an executor durability guard that prevents silent requeue when a task worktree still has uncommitted attributable changes. Affected recovery/requeue paths now park the task as failed with stranded-worktree diagnostics (including worktree path and recovery hints) instead of dropping back to todo without operator visibility.
