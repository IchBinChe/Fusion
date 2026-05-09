---
"@runfusion/fusion": patch
---

Fix merge-queue auto-recovery loops caused by stale `status: "merging"` / `"merging-pr"` task states. Self-healing now clears stale transient merge statuses only when no active merger owns the task and the state is older than a safety threshold, and mergeable-review recovery now skips transient merge statuses to avoid noisy re-enqueue spam while the cross-process active-merge guard is blocked.
