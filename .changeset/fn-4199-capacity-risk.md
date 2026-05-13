---
"@runfusion/fusion": minor
---

Add capacity-risk warning when the Todo queue exceeds the configured threshold and no idle non-ephemeral agents are available. New project setting `capacityRiskTodoThreshold` (default 20). `GET /api/agents/stats` now also returns `idleNonEphemeralCount` and `todoTaskCount`.
