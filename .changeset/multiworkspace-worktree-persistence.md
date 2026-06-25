---
"@runfusion/fusion": patch
---

Fix multiworkspace tasks failing to complete. `task.workspaceWorktrees` is now durably persisted (it previously had no SQLite column, so `fn_acquire_repo_worktree`'s write was dropped on every persist and `fn_task_done` always reported "acquired no sub-repo worktrees"). Concurrent workspace tasks no longer collide on the shared browse-root active-session path — each task gets a task-scoped session key, so a second workspace task no longer fails with "active-session path … is held by …".
