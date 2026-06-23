---
"@runfusion/fusion": patch
---

Tighten agent workflow-routing prompt policy so triage and executor agents must not move a task's workflow unless the user explicitly requested it or the agent created that task. Executor prompts now include an explicit `fn_workflow_select` guardrail while preserving workflow selection for tasks agents create.
