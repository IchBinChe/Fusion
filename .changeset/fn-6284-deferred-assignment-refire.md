---
"@runfusion/fusion": patch
---

Re-fire durable-agent assignment wakes that were skipped because the agent was mid-heartbeat, so newly assigned tasks are worked when the active run completes instead of waiting for the next timer tick.
