---
"@runfusion/fusion": patch
---

summary: Default workflow boards now label the intake column "Planning" instead of "Triage".
category: fix
dev: Renamed the `name` of the `id: "triage"` intake column to "Planning" in builtin-coding, builtin-stepwise-coding, and builtin-pr workflow IRs (column id unchanged; linear built-ins inherit via canonicalBuiltinWorkflowColumns). COLUMN_LABELS.triage was already "Planning".
