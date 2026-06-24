---
"@runfusion/fusion": minor
---

Workspace tasks no longer render blank in the dashboard. Task cards and the task
detail view now surface a workspace task's acquired per-sub-repo worktrees as a
read-only "N repos acquired" placeholder and flat repo → worktree/branch list,
instead of an empty branch area (no `task.worktree`/`task.branch`).
