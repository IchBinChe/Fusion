---
"@runfusion/fusion": minor
---

summary: Permanent and custom agents can list, show, and search tasks during heartbeat runs.
category: feature
dev: Adds shared read-only task tool factories (createTaskListTool/createTaskShowTool/createTaskSearchTool/createTaskReadTools), wires them into createSharedHeartbeatWorkTools, classifies fn_task_search/fn_task_get read-only, and adds cross-surface drift tests.
