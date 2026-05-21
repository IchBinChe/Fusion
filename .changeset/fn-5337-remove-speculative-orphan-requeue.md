---
"@runfusion/fusion": patch
---

Self-healing: remove speculative auto-requeue from `recoverOrphanedExecutions`. The sweep no longer calls lease-manager recovery/reconcile, no longer writes `status: "stuck-killed"` or clears `worktree`/`branch`, no longer writes the `Auto-recovered orphaned executor task` log entry, and no longer moves tasks back to `todo`.

`recoverOrphanedExecutions` is now observation-only and emits `task:orphan-detected-no-action` run-audit events plus `[orphan-detected]` diagnostics when stale in-progress candidates are detected. Proof-based lifecycle recovery remains owned by `recoverInProgressLimbo`, `RestartRecoveryCoordinator`, and explicit executor/merger failure paths (fixes FN-5279 false-positive class).
