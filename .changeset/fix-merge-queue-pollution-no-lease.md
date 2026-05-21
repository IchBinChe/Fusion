---
"@runfusion/fusion": patch
---

Fix merge-queue reuse-handoff contention that caused `merge:reuse-handoff-refused` (`reason=no-lease`) for valid in-review tasks when unrelated rows polluted queue head state. `acquireMergeQueueLease({ targetTaskId })` now honors the target strictly (no queue-head fallback), and merge-queue lifecycle handling is now column-aware: enqueue is rejected for non-`in-review` tasks, lease selection auto-cleans stale non-review rows, and `in-review` column exits scrub queue rows when leases are absent or expired.
