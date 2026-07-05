---
"@runfusion/fusion": patch
---

summary: Clarify the task-detail planner-oversight Nudge/Explain controls with a visible label, an in-DOM disabled reason, and an always-openable Explain panel.
category: fix
dev: TaskDetailModal now renders a `detail-oversight-controls-label` group label and `detail-overseer-nudge-disabled-reason` helper text (both gated by the existing oversight-cluster visibility condition); Explain no longer disables on `!canExplainOverseer` since it is read-only. Nudge's `canNudgeOverseer` gate and Stop's confirm dialog are unchanged.
