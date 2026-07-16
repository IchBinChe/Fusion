---
"@runfusion/fusion": patch
---

summary: Plan Review no longer loops forever on reviewer retry storms — it fails the task with a clear error.
category: fix
dev: runPlanReviewBeforeExecution now terminalizes RetryStormError (status "failed", serialized error, nextRecoveryAt cleared) instead of re-queuing plan-review-unavailable, which had let reviewerFallbackRetryCount climb unbounded past maxReviewerFallbackRetries.
