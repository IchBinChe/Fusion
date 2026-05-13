---
"@runfusion/fusion": patch
---

Fix plan-review UNAVAILABLE silently stalling tasks in-progress by retrying reviewer verdict extraction once (preferring validator fallback model) and degrading plan/spec UNAVAILABLE outcomes to advisory when retries are exhausted.
