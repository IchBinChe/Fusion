---
"@runfusion/fusion": patch
---

summary: Mission feature validator now inspects the merged commit and defers instead of false-failing on branch divergence.
category: fix
dev: runValidation materializes a disposable detached checkout of mergeDetails.commitSha (never baseCommitSha) and computes the stale-workspace ancestry guard against that inspection root before disposal; startValidatorRun now carries taskId.
