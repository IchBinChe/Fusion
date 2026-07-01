---
"@runfusion/fusion": patch
---

summary: Prevent task branches from inheriting unrelated checked-out task commits.
category: fix
dev: Fresh worktree acquisition now pins the integration branch as the default start point, and merge finalization validates task-owned branch diffs from baseCommitSha when available.
