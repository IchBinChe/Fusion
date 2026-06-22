---
"@runfusion/fusion": minor
---

Workspace mode (Phase A / U2): harden per-repo worktree acquisition. Each sub-repo worktree now gets the task identity guard installed (single-repo parity), a per-repo base commit SHA captured local-first against that sub-repo's resolved integration branch (shared `integrationBranch` override stripped so each repo falls through to its own `origin/HEAD`), and same-sub-repo acquisition exclusivity registered in the path-keyed active-session registry. Re-acquiring an already-acquired `(taskId, repo)` is idempotent, and acquisition failures surface an error plus an audit event instead of silently stalling.
