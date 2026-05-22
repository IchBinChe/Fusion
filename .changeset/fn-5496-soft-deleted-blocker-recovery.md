---
"@runfusion/fusion": patch
---

Improve soft-deleted blocker recovery so blocked tasks become schedulable without manual intervention. `SelfHealingManager.clearStaleBlockedBy` now emits an explicit `soft-deleted at ...` reason when a stale blocker is a soft-deleted row, and the scheduler now reconciles downstream `blockedBy`/dependency state immediately on `task:deleted` events to reblock on remaining live deps or unblock tasks in the same tick.