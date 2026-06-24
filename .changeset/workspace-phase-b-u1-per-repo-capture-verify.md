---
"@runfusion/fusion": minor
---

Workspace mode (Phase B, U1): per-repo post-session change capture, contamination detection, and worktree-invariant verification. In workspace mode the executor now loops `task.workspaceWorktrees`, reusing `captureModifiedFiles` per sub-repo (diffing each against its own `baseCommitSha`, with a merge-base fallback when undefined) to aggregate repo-prefixed `task.modifiedFiles` and surface per-repo contamination, and un-stubs `verifyWorktreeInvariants` to assert each acquired worktree's git toplevel and `fusion/<id>` branch. Single-repo behavior is unchanged.
