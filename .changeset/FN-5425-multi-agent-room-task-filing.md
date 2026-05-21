---
"@runfusion/fusion": patch
---
Add a Room Coordination Notices prompt-injected advisory that fires when a
user posts an explicit "file a task" / "create a task" request into a chat
room with multiple agent members. Each agent is instructed to either post a
one-line claim before calling fn_task_create (claim branch) or to defer and
acknowledge a peer's prior claim/announcement (defer-suggested branch),
reducing the upstream duplicate pressure on the existing FN-4918 / FN-4829
/ FN-5152 / FN-5220 dedup backstop. Emits a structured
room:coordination:branch run-audit event per decision. Single-agent rooms
and non-task-filing messages are unaffected.
