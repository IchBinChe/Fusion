---
"@runfusion/fusion": patch
---

Fix a false "engine not running" banner when another fusion process on the same machine already owns the engine. The dashboard's health check only counted engines this process started, so a second launch (e.g. `pnpm dev dashboard` alongside an already-running `fusion`) that was correctly refused the per-machine engine singleton lock reported the engine as unavailable — even though one was running. The `ProjectEngineManager` now tracks engines owned by another process (detected via `EngineAlreadyRunningError` from the singleton lock) and exposes `hasRunningEngine()`, which the dashboard health endpoint uses so the banner reflects machine-level truth. Reconciliation still retries so this process takes over if the other exits, and the "refusing to start" log is emitted once per project instead of on every reconciliation tick.
