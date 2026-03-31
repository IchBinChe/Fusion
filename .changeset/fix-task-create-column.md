---
"@dustinbyrne/kb": patch
---

Fix task_create tool to explicitly set column: "triage"

The executor agent's task_create tool now explicitly passes `column: "triage"`
when creating tasks via the store. This ensures tasks created during execution
always land in triage for proper specification by the AI, matching the behavior
of the triage agent's task_create tool.
