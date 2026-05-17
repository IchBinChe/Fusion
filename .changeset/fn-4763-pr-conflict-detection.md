---
"@runfusion/fusion": patch
---

Detect PR merge conflicts via gh PR refresh and route affected tasks through the existing self-healing branch-reclaim path. Adds an optional `mergeable` field on `PrInfo`, a "Retry conflict reclaim" affordance in the PR section, and a new `POST /api/tasks/:id/pr/reclaim-conflict` endpoint.
