---
"@runfusion/fusion": minor
---

summary: Deprecate the built-in Coding (Ideas) workflow — it no longer appears for new task selection.
category: internal
dev: builtin:coding-ideas is excluded from defaultEnabledBuiltinWorkflowIds() and hidden from listWorkflowDefinitions via the shared DEPRECATED_BUILTIN_WORKFLOWS registry / isBuiltinWorkflowDeprecated helper; it remains resolvable by id for existing task selections. Applied only after a preflight verified no active task (including parked ideas in the `ideas` intake column) selects it.
