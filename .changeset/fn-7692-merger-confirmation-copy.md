---
"@runfusion/fusion": patch
---

summary: Fix misleading merger "awaiting-confirmation" copy that claimed a hard block when auto-merge advances the merge automatically.
category: fix
dev: `decidePlannerRecovery` now accepts an additive `autoMergeWillProceed` flag (threaded from `allowsAutoMergeProcessing` in `PlannerRecoveryController.tick`) that only shapes the confirmation `reason` string; no gating/behavior change to `action`/`requiresConfirmation`/`sideEffectClass`.
