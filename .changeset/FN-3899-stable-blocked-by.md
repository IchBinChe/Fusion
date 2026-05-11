---
"@runfusion/fusion": patch
---

Fix scheduler overwriting `blockedBy` on queued todo tasks every tick, which caused unrelated work to converge on a single broad-scope in-progress task. Stamping is now sticky-when-still-valid with deterministic tiebreak.
