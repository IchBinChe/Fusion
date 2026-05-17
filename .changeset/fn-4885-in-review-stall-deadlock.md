---
"@runfusion/fusion": patch
---

Self-healing now auto-disposes in-review tasks whose identical stall (same code + reason) repeats past `inReviewStallDeadlockThreshold` (default 3) by pausing the task with `pausedReason="in-review-stall-deadlock"` and emitting a `task:in-review-stall-deadlock-disposed` run-audit event, preventing infinite stall-log churn (e.g., repeated `merge-blocker: Failed to create worktree after 3 attempts` loops).
