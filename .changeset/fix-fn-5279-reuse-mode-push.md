---
"@runfusion/fusion": patch
---

Fix reuse-task-worktree merge mode (FN-5279) never applying the squash commit to the project root's local integration branch. The merger detaches HEAD in the task worktree and lands the squash on the detached HEAD; previously nothing advanced the project root's local `main`, so changes never appeared on the user's `main` (and any subsequent `pushAfterMerge` would push the stale ref or fail outright because `parsePushRemoteTarget` can't resolve a branch from a detached HEAD). A new step 5c now applies the squash to the project root's integration branch via `git merge --ff-only`, falling back to a regular merge with AI conflict resolution if `main` has diverged. Push-after-merge (when enabled) now runs from the project root where the integration branch was just advanced.
