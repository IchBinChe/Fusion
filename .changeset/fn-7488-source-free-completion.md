---
"@runfusion/fusion": patch
---

summary: Allow documented source-free task-artifact deliveries to finish without commits.
category: fix
dev: fn_task_done now recognizes explicit gitignored .fusion/tasks artifact contracts while preserving source-change no-commit guards.
