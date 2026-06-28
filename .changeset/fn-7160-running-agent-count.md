---
"@runfusion/fusion": patch
---

summary: Running-agent counts include active in-review agents, and the concurrency use-marker is no longer off by one.
category: fix
dev: Adds shared isRunningAgentTask/countRunningAgentTasks in @fusion/core; engine concurrency.persistedTopLevelAgentSlots and the dashboard/CLI count surfaces delegate to it. CommandCenterControls use-marker ratio is now 0-based.
