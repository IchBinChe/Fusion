---
"@runfusion/fusion": minor
---

Add a run-audit cited-goal trail for goal anchoring flows.

- Enrich `goal:injection-applied`, `goal:injection-skipped`, and `goal:retrieval-invoked` events with `metadata.goalIds` (IDs/counts only).
- Add core aggregation helper `collectCitedGoalIdsFromAudit(...)` to derive injected/retrieved/combined cited goal IDs from run-audit events.
- Add dashboard API endpoint `GET /api/agents/:id/runs/:runId/cited-goals` to query cited goal IDs for a run.
