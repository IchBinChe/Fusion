---
"@runfusion/fusion": patch
---

Fix infinite todo↔in-review loop on tasks whose previous run exhausted their merge budget. The scheduler now resets `mergeRetries` to 0 when dispatching a task to in-progress, so each fresh execution gets a fresh merge budget. Without this, a task with `mergeRetries=MAX` and `status=null` would land back in in-review, the merger would refuse it (`canMergeTask` false), and the ghost-review fallback would bounce it to todo every 10 minutes — before the 30-minute merge-cooldown could elapse.
