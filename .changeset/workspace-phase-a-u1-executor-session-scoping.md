---
"@runfusion/fusion": minor
---

Workspace mode Phase A (U1): executor session scoping. In workspace mode the executor now skips the root worktree acquisition and every rootDir git preflight (base-commit capture, contamination, worktree-liveness), runs the agent session rooted at the browse-only workspace root, and tracks acquired sub-repo worktrees as a per-task set. Single-repo tasks are unchanged (one-element set, byte-for-byte preflight parity).
