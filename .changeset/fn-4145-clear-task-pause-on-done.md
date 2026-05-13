---
"@runfusion/fusion": patch
---

Fix: clear task-level pause on `fn_task_done` so explicit agent completions cannot strand tasks in a `paused` state. Hard-pause gating for deferred completion handoff now keys off `globalPause` only.
