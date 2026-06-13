---
"@runfusion/fusion": patch
---

Move AI-merge clean-room worktrees into a repo-local cleanup-exempt root, guard cleanup sweeps by active merge ownership, and classify missing clean-room worktree failures as transient so merges can retry cleanly.
