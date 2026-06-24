import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { WorkspaceWorktreesSummary, isWorkspaceTask } from "../WorkspaceWorktreesSummary";

/*
FNXC:Workspace 2026-06-21-00:00:
U3/KTD5 dashboard "doesn't look broken" floor. Asserts the invariant across both surfaces
the summary serves (FN-5893):
- happy path: workspace task (no task.worktree, two workspaceWorktrees entries) renders a
  flat per-repo list + "N repos acquired" placeholder — no crash, not blank.
- regression: single-repo task (task.worktree set, no workspaceWorktrees) renders nothing
  from this guard, so its existing rendering stays unchanged.
Narrow seam: tests the presentational component directly, no API / SSE / timers (FN-5048).
*/

const workspaceTask = {
  worktree: undefined,
  workspaceWorktrees: {
    "repo-a": { worktreePath: "/wt/repo-a", branch: "fusion/fn-1-a" },
    "repo-b": { worktreePath: "/wt/repo-b", branch: "fusion/fn-1-b" },
  },
} as const;

const singleRepoTask = {
  worktree: "/wt/single",
  workspaceWorktrees: undefined,
} as const;

describe("isWorkspaceTask", () => {
  it("is true when worktree is absent and workspaceWorktrees has entries", () => {
    expect(isWorkspaceTask(workspaceTask)).toBe(true);
  });

  it("is false for a single-repo task (worktree set)", () => {
    expect(isWorkspaceTask(singleRepoTask)).toBe(false);
  });

  it("is false when workspaceWorktrees is an empty record", () => {
    expect(isWorkspaceTask({ worktree: undefined, workspaceWorktrees: {} })).toBe(false);
  });

  it("prefers the singular worktree even if workspaceWorktrees is populated", () => {
    expect(
      isWorkspaceTask({ worktree: "/wt/x", workspaceWorktrees: workspaceTask.workspaceWorktrees }),
    ).toBe(false);
  });
});

describe("WorkspaceWorktreesSummary", () => {
  it("renders a flat per-repo list and placeholder for a two-repo workspace task (no crash, not empty)", () => {
    render(<WorkspaceWorktreesSummary task={workspaceTask} />);

    // Placeholder reflects the repo count.
    expect(screen.getByTestId("workspace-worktrees-placeholder").textContent).toContain("2");
    expect(screen.getByText(/2 repos acquired/i)).toBeTruthy();

    // Flat per-repo list: each repo path, worktree path, and branch is shown.
    const summary = screen.getByTestId("workspace-worktrees-summary");
    expect(summary).toBeTruthy();
    expect(screen.getByText("repo-a")).toBeTruthy();
    expect(screen.getByText("repo-b")).toBeTruthy();
    expect(screen.getByText("/wt/repo-a")).toBeTruthy();
    expect(screen.getByText("/wt/repo-b")).toBeTruthy();
    expect(screen.getByText("fusion/fn-1-a")).toBeTruthy();
    expect(screen.getByText("fusion/fn-1-b")).toBeTruthy();
  });

  it("renders only the compact placeholder in compact mode", () => {
    render(<WorkspaceWorktreesSummary task={workspaceTask} compact />);
    expect(screen.getByTestId("workspace-worktrees-placeholder").textContent).toContain("2 repos");
    // Compact variant omits the full per-repo list.
    expect(screen.queryByTestId("workspace-worktrees-summary")).toBeNull();
    expect(screen.queryByText("/wt/repo-a")).toBeNull();
  });

  it("renders nothing for a single-repo task, leaving existing rendering unchanged", () => {
    const { container } = render(<WorkspaceWorktreesSummary task={singleRepoTask} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("workspace-worktrees-summary")).toBeNull();
    expect(screen.queryByTestId("workspace-worktrees-placeholder")).toBeNull();
  });

  it("renders nothing when workspaceWorktrees is empty", () => {
    const { container } = render(
      <WorkspaceWorktreesSummary task={{ worktree: undefined, workspaceWorktrees: {} }} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
