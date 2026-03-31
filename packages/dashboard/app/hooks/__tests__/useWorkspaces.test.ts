import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useWorkspaces } from "../useWorkspaces";
import * as api from "../../api";

vi.mock("../../api", () => ({
  fetchWorkspaces: vi.fn(),
}));

const mockFetchWorkspaces = vi.mocked(api.fetchWorkspaces);

describe("useWorkspaces", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockFetchWorkspaces.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("loads project and task workspaces", async () => {
    mockFetchWorkspaces.mockResolvedValueOnce({
      project: "/Users/test/repo",
      tasks: [{ id: "KB-123", title: "Feature", worktree: "/Users/test/.worktrees/kb-123" }],
    });

    const { result } = renderHook(() => useWorkspaces());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.projectName).toBe("repo");
    expect(result.current.workspaces).toEqual([
      {
        id: "KB-123",
        label: "KB-123",
        title: "Feature",
        worktree: "/Users/test/.worktrees/kb-123",
        kind: "task",
      },
    ]);
  });

  it("polls for workspace updates", async () => {
    mockFetchWorkspaces
      .mockResolvedValueOnce({ project: "/repo", tasks: [] })
      .mockResolvedValueOnce({
        project: "/repo",
        tasks: [{ id: "KB-200", title: "Later", worktree: "/repo/.worktrees/kb-200" }],
      });

    const { result } = renderHook(() => useWorkspaces());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.workspaces).toEqual([]);

    await vi.advanceTimersByTimeAsync(10000);

    await waitFor(() => expect(result.current.workspaces).toHaveLength(1));
    expect(mockFetchWorkspaces).toHaveBeenCalledTimes(2);
  });

  it("surfaces fetch errors", async () => {
    mockFetchWorkspaces.mockRejectedValueOnce(new Error("Failed to load workspaces"));

    const { result } = renderHook(() => useWorkspaces());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe("Failed to load workspaces");
    expect(result.current.workspaces).toEqual([]);
  });
});
