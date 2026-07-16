---
"@runfusion/fusion": patch
---

summary: Plan Review now allows more automatic replan attempts (default 8) before asking a human.
category: internal
dev: Raised triage PLAN_REVIEW_GATE_REPLAN_CAP from 3 to 8 in packages/engine/src/triage.ts; escalation to awaiting-approval (awaitingApprovalReason "plan-review-replan-cap") now fires at 8 consecutive REVISE replans.
