---
"@runfusion/fusion": minor
"runfusion.ai": minor
"@fusion/core": minor
"@fusion/dashboard": minor
"@fusion/desktop": minor
"@fusion/engine": minor
"@fusion/mobile": minor
"@fusion/pi-claude-cli": minor
"@fusion/plugin-sdk": minor
---

Allow tasks to be respecified from `in-review`. `VALID_TRANSITIONS["in-review"]` now includes `triage`, so the dashboard's `Request AI Revision` and `Rebuild Spec` actions work for in-review tasks. Moving an in-review task to triage performs the same full reset as in-review → todo (clears branch/baseBranch/baseCommitSha/summary/recovery metadata and workflowStepResults) so the next run starts from scratch. The in-review card's `Move` menu also now offers `Planning` as a destination.
