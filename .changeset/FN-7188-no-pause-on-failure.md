---
"@runfusion/fusion": patch
---

summary: Agents no longer pause tasks on failure — pausing is reserved for explicit user requests.
category: fix
dev: Adds a no-pause-on-failure standing rule to HEARTBEAT_SYSTEM_PROMPT / HEARTBEAT_NO_TASK_SYSTEM_PROMPT, clarifies the fn_task_pause tool description, and regenerates the fusion skill docs (sync:fusion-skill).
