---
"@runfusion/fusion": patch
"@fusion/core": patch
---

Harden the orphan-worktree and stale-task-dir cleanup fixes (code-review follow-up).

- **executor.ts (P0):** the stale-conflict recovery's `rm(worktreePath, { recursive, force })` had no bounds check. `worktreePath` can originate from a git worktree admin entry that resolves outside `.worktrees/`, so an out-of-bounds or symlinked path could be force-removed. The recovery now refuses unless the path is inside the configured worktrees dir, is not a symlink (checked via `realpathSync`), is not a registered git worktree, and is not actively owned — and it re-verifies liveness inside the catch rather than trusting the error string. It also excludes `spawn` failures (e.g. `spawn git ENOENT` when git is missing) so a missing-binary error is no longer misread as a successful stale-path cleanup.
- **worktree-pool.ts:** `resolveGitdirPointer` is replaced by `dotGitPointerIsDangling`, which reaps **only** when a `.git` link's gitdir target is confirmed missing. A real `.git` directory, an unparseable pointer, or any read/stat failure now returns "not dangling" (conservative) so a transient read error on a live worktree's `.git` can't cause a force-remove. Removes the `string | "directory" | null` sentinel union.
- **core store.ts:** the `reconcileOrphanedTaskDirs` recency window is now bypassed when the live task table is empty (the corruption/restore case — surviving `task.json` files keep old mtimes), and when a corrupt `fusion.db` was auto-recovered on startup, so `.recover` row loss is not stranded by the gate. Adds an `ignoreRecencyWindow` option for explicit callers.
- Tests for all of the above: executor recovery + out-of-bounds refusal, unparseable `.git` skip, recency boundary, empty-DB/forced bypass.
