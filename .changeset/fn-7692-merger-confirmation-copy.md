---
"@runfusion/fusion": patch
---

summary: Fix merger awaiting-confirmation copy that implied a hard block when auto-merge proceeds automatically.
category: fix
dev: `decidePlannerRecovery` now accepts an additive `autoMergeWillProceed` flag (threaded from `allowsAutoMergeProcessing` in `PlannerRecoveryController.tick`) that only shapes the confirmation `reason` string; no gating/behavior change to `action`/`requiresConfirmation`/`sideEffectClass`.
