---
"@runfusion/fusion": minor
---

Add workspace mode: open a folder of git repositories as a single Fusion
project. The agent acquires per-repo worktrees on demand via
`fn_acquire_repo_worktree` as it discovers it needs to work in each sub-repo.
