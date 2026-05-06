---
"@runfusion/fusion": patch
---

Restore the documented agent lifecycle by removing `terminated` as an agent state again. Agent stop flows now land on `paused`, while heartbeat run history continues to use `terminated` as a run-status value and existing persisted terminated agents migrate to `paused` on startup.
