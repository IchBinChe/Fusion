---
"@runfusion/fusion": patch
---

summary: The running-agents count now includes agents actively triaging tasks, not just executors.
category: fix
dev: countRunningAgentsInStore now adds triage-column tasks with status "planning" (not paused) to the live running-agent count alongside in-progress tasks, matching the maxTriageConcurrent liveness predicate; feeds getLiveRunningAgentCounts and the global-concurrency readouts.
