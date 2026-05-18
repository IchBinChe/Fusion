---
"@runfusion/fusion": patch
---

Fix executor step-order corruption: `fn_review_step` off-by-one when auto-updating step status, `resetStepsIfWorkLost` now recomputes `currentStep` so execution does not resume past wiped work, and `TaskStore.updateStep` refuses out-of-order `done` writes.
