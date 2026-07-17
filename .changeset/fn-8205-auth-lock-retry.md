---
"@runfusion/fusion": patch
---

summary: Prevent transient credential-file lock contention from terminating provider runs.
category: fix
dev: Uses queued async auth writes with a shared proper-lockfile retry budget.
