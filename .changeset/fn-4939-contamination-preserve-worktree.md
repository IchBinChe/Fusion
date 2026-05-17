---
"@runfusion/fusion": patch
---

Fix contamination auto-recovery nulling `task.worktree` while leaving a live worktree mapped on disk, which triggered transient `no-worktree-no-merge-confirmed` stall signals in the dashboard. The in-line recovery in `executor.ts` now:

- Runs `autoRecoverCrossContamination` inside the task's worktree (when one exists) so the final `git checkout <branch>` doesn't collide with the branch already being checked out elsewhere — the previous `repoDir: this.rootDir` call would silently fail for any task that had a real worktree.
- Passes `preserveWorktree: true` when requeueing to `todo`, matching the sibling recovery paths in `auto-recovery-handlers/contamination.ts`, `tryBootstrapMisbindingRecovery`, and self-healing reclaim.
