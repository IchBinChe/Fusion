---
"@runfusion/fusion": patch
---

summary: Recover live worktree conflicts by retrying with a fresh task worktree.
category: fix
dev: Executor worktree acquisition now preserves active-session conflict owners and retries bounded sibling branches instead of surfacing automatic cleanup failure.
