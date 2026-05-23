---
"@fusion/engine": minor
"@fusion/core": patch
---

feat(engine): merger auto-syncs project-root checkout after advancing integration-branch ref

Wires `mergeAdvanceAutoSync` into the merger's post-ref-advance code path. After `advanceIntegrationBranchRef` ff-updates `refs/heads/<integrationBranch>`, the merger now enumerates other worktrees still on that branch (typically the user's project-root checkout) and reconciles each one's index + working tree to the new tip via `syncWorktreeToHead`.

The reconciliation primitive is **not** a `git pull` — origin may still be at the previous tip (no `pushAfterMerge`), in which case `git pull --ff-only` is a no-op and a naive `stash → pull → pop` ends with the worktree restored to the old state. Instead `syncWorktreeToHead`:

1. Diffs the worktree against the *previous* tip to isolate real user edits from the stale-index "phantom diff" that looks like inverted commits.
2. When the worktree is clean against the previous tip, runs `git reset --hard HEAD` to snap index + files forward.
3. In `stash-and-ff` mode with real edits, captures them as a binary patch against the previous tip, snaps to HEAD, then `git apply --3way` to restore. Untracked files are copied to a temp dir and restored after the snap. Patch conflicts surface as `synced-with-pop-conflict` with the patch left on disk for manual recovery.

Each per-worktree attempt emits a `merge:auto-sync` audit event (new `GitMutationType`) with the outcome; the per-step `pull:fast-forward`, `stash:push`, `stash:pop`, and `stash:pop-conflict` events that pass through the auditor are tagged `metadata.autoSync = true` so downstream consumers can attribute them.

The user-facing effect: with the default `mergeAdvanceAutoSync: "stash-and-ff"`, after a Fusion task merges the user's `git status` in the project-root checkout becomes clean and the working tree shows the new commits' content — no manual `git reset` or Pull-button click required. Set `mergeAdvanceAutoSync: "off"` to restore the legacy behavior (the Merge Advance Notice banner still surfaces and the user pulls by hand).

Backstopped by `merger-auto-sync.slow.test.ts` covering: clean-sync snaps both index and files forward, ff-only with real edits is a no-op, stash-and-ff preserves untracked local files across the snap, task worktrees on `fusion/fn-*` branches are correctly skipped, and an empty branch map emits nothing.
