---
"@runfusion/fusion": patch
---

summary: Concurrency panels now read running-agent counts from a single live source shared across the app.
category: internal
dev: Adds a side-effect-safe CentralCore.getLiveRunningAgentCounts() seam (DI source via setRunningAgentCountSource) that derives counts from in-progress task columns of already-open project stores without starting engines/watchers or mutating slot/health bookkeeping; GET /api/global-concurrency is rewired onto it, preserving globalMaxConcurrent/queuedCount and acquireGlobalSlot/releaseGlobalSlot semantics.
