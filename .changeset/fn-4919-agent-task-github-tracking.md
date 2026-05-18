---
"@runfusion/fusion": patch
---

Ensure GitHub tracking post-create hooks are registered across engine startup entrypoints so agent-created tasks (including `fn_task_create` and `fn_delegate_task`) consistently evaluate default tracking settings and link issues when configured, with improved diagnostics for skipped tracking outcomes.
