---
"@runfusion/fusion": patch
---

summary: Permanent agents now obey approval/block policy when creating tasks.
category: fix
dev: Removed fn_task_create from READONLY_FN_TOOLS and classified it as task_agent_mutation in the permanent-agent gate (packages/engine/src/gating-classifications.ts); action-gate classification unchanged. fn_delegate_task and GitHub import tools intentionally left permanent-readonly.
