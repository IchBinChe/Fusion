---
"@runfusion/fusion": patch
---

Fix scheduler `blockedBy` propagation so dependency-unblocked todo tasks are not re-pointed to unrelated overlap blockers, and extend stale-blocker recovery to clear corrupted `blockedBy` rows that no longer match unresolved dependencies.
