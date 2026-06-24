---
"@runfusion/fusion": minor
---

Workspace mode Phase C (U2): per-repo landed predicate, finalize-once, and idempotent
auto-retry-then-park. `landWorkspaceTask` now records each sub-repo's `landedSha` after
its branch advances that repo's local integration ref, and on a re-run SKIPS any repo
whose recorded `landedSha` is an ancestor of (or equals) its current integration tip — so
an interrupted multi-repo land retries only the un-landed repos and never re-advances an
already-landed ref. When every acquired repo's landed predicate holds, the task moves to
`done` EXACTLY ONCE via the task-global finalize path with an aggregate `mergeDetails`
(representative `commitSha` + a `workspaceLandedShas` map). A partial land (some repos
unlanded) does not move the task done; the engine merge dispatch surfaces it as a
retryable failure that consumes a `mergeRetry` and auto-retries the merge (skipping landed
repos) up to the configured max, then operator-parks the task as failed.
