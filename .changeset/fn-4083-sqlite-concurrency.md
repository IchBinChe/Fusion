---
"@runfusion/fusion": patch
---

Improve SQLite write reliability under concurrent executor activity by enforcing WAL/busy-timeout setup on every disk-backed connection, using explicit immediate transactions for task+audit writes, and adding disk-backed concurrent-write regression coverage.
