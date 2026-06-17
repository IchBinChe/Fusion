---
"@runfusion/fusion": patch
---

Resolve task-list text formatting defensively when an installed core package is missing the `formatTaskListText` runtime export, preserving `fn_task_list` output with a bounded inline fallback.
