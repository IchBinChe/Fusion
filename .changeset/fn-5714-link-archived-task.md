---
"@runfusion/fusion": patch
---

Improve `fn_feature_link_task` error handling when linking to tasks that are not on the active board. Instead of surfacing a raw SQLite foreign key failure, the tool now returns a clear validation error explaining that only active (non-archived, non-deleted) tasks can be linked to mission features.