import { useTranslation } from "react-i18next";
import type { Task } from "@fusion/core";

/*
FNXC:Workspace 2026-06-21-00:00:
Dashboard "doesn't look broken" floor (Phase A U3 / master U10, KTD5).
A workspace-mode task has NO singular `task.worktree`/`task.branch`; instead it carries
`task.workspaceWorktrees` — one acquired git worktree per sub-repo, keyed by repo path
relative to the workspace root. Existing display surfaces (TaskCard branch row, TaskDetail
metadata) key off the singular `task.branch`, so a workspace task would render an EMPTY
branch area — looking broken. This guard renders a static placeholder ("N repos acquired")
plus a flat read-only per-repo path/branch list so the task is observable, never crashing
and never blank.

Scope ceiling: flat read-only list / placeholder ONLY. A rich per-repo-status component
(live diff/lease/merge state per repo) is the deferred registration UI — out of scope here.
Single-repo rendering is untouched: callers only mount this when `isWorkspaceTask(task)`.
*/

/**
 * True when the task is a workspace-mode task: no singular `worktree` recorded
 * and at least one acquired per-sub-repo worktree in `workspaceWorktrees`.
 * Single-repo tasks (populated `worktree`, no `workspaceWorktrees`) return false,
 * keeping their existing rendering byte-for-byte unchanged.
 */
export function isWorkspaceTask(task: Pick<Task, "worktree" | "workspaceWorktrees">): boolean {
  if (task.worktree) return false;
  const entries = task.workspaceWorktrees;
  return Boolean(entries && Object.keys(entries).length > 0);
}

interface WorkspaceWorktreesSummaryProps {
  task: Pick<Task, "worktree" | "workspaceWorktrees">;
  /** Compact variant for the dense TaskCard surface (placeholder only). */
  compact?: boolean;
}

/**
 * Read-only summary of a workspace task's acquired sub-repo worktrees.
 *
 * - `compact` (TaskCard): renders just the "N repos acquired" placeholder chip.
 * - default (TaskDetail): renders the placeholder plus a flat per-repo list of
 *   `repo → worktreePath (branch)`.
 *
 * Renders nothing for non-workspace tasks; mount only behind `isWorkspaceTask`.
 */
export function WorkspaceWorktreesSummary({ task, compact = false }: WorkspaceWorktreesSummaryProps) {
  const { t } = useTranslation("app");
  const entries = task.workspaceWorktrees;
  if (!isWorkspaceTask(task) || !entries) return null;

  const repos = Object.entries(entries);
  const placeholder = t("tasks.workspaceReposAcquired", "{{count}} repos acquired", { count: repos.length });

  if (compact) {
    return (
      <div className="card-branch-row" aria-label={t("tasks.workspaceWorktrees", "Workspace repos")}>
        <span className="card-branch-chip" data-testid="workspace-worktrees-placeholder" title={placeholder}>
          <span className="card-branch-label">{t("tasks.workspace", "Workspace")}</span>
          <span className="card-branch-value">{placeholder}</span>
        </span>
      </div>
    );
  }

  return (
    <div
      className="workspace-worktrees-summary"
      data-testid="workspace-worktrees-summary"
      aria-label={t("tasks.workspaceWorktrees", "Workspace repos")}
    >
      <div className="workspace-worktrees-placeholder" data-testid="workspace-worktrees-placeholder">
        {placeholder}
      </div>
      <ul className="workspace-worktrees-list">
        {repos.map(([repoRelPath, info]) => (
          <li key={repoRelPath} className="workspace-worktrees-item">
            <span className="workspace-worktrees-repo" title={repoRelPath}>
              {repoRelPath}
            </span>
            <span className="workspace-worktrees-path" title={info.worktreePath}>
              {info.worktreePath}
            </span>
            <span className="workspace-worktrees-branch" title={info.branch}>
              {info.branch}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
