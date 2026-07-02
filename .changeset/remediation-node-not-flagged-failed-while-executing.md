---
"@runfusion/fusion": patch
---

summary: Stop showing "Task Failed" on a task whose code-review remediation is still running.
category: fix
dev: handleGraphFailure now skips the terminal `status:"failed"` park when the failed graph node is a `pre-merge-remediation`/`plan-replan` node (e.g. `code-review-remediation`) AND a live agent session surface is still registered for the task. These nodes are fire-and-forget async schedulers with no `failure` out-edge, so a failed re-arm (missing rehydrated failureContext after restart, remediation-not-scheduled, or exhausted rework budget) bubbled out as the terminal graph outcome and stamped a spurious failure over live work. Scoped via `isRemediationGraphNode` (IR `workflowAction` with built-in node-id fallback) + `hasLiveTaskSessionSurface`; genuine execute/merge failures and remediation failures with no live session still park failed unchanged.
