---
"@runfusion/fusion": minor
---

Move agent logs out of the SQLite `agentLogEntries` table into per-task `.fusion/tasks/{ID}/agent-log.jsonl` files, add one-time migration + source-ref rewrite support, preserve soft-deleted log files for forensics while hiding them from live reads, and switch goal-citation source refs to `agentLog:{taskId}:{lineNo}`.
