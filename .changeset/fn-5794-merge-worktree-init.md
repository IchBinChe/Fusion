---
"@runfusion/fusion": patch
---

Run the configured `worktreeInitCommand` when the merger has to create a fresh merge worktree during reuse-worktree reacquisition. This bootstraps newly created merge workspaces before merge verification/workflow steps run, while leaving pooled/reused existing worktrees unchanged.
