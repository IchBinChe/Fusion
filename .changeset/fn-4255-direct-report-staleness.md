---
"@runfusion/fusion": patch
---

Fixes direct-report health classification in heartbeat report summaries to use each report's configured heartbeat interval instead of heartbeat timeout budget. Reports are now marked stale only when heartbeat age exceeds `max(heartbeatIntervalMs × 4, 5 minutes)`, matching the dashboard health semantics and preventing false stale flags for agents still within their scheduled cadence.
