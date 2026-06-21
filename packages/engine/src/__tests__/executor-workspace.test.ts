// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadWorkspaceConfig } from "@fusion/core";
import { acquireWorkspaceRepoWorktree } from "../worktree-acquisition.js";

vi.mock("@fusion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/core")>();
  return {
    ...actual,
    loadWorkspaceConfig: vi.fn(),
  };
});

vi.mock("../worktree-acquisition.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../worktree-acquisition.js")>();
  return {
    ...actual,
    acquireWorkspaceRepoWorktree: vi.fn(),
  };
});

const mockedLoadWorkspaceConfig = vi.mocked(loadWorkspaceConfig);
const mockedAcquireWorkspaceRepoWorktree = vi.mocked(acquireWorkspaceRepoWorktree);

const MOCK_WORKSPACE_CONFIG = {
  repos: ["wolf-server", "wolf-community-frontend-1"],
};

describe("acquireWorkspaceRepoWorktree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns alreadyAcquired=false for a fresh repo", async () => {
    mockedAcquireWorkspaceRepoWorktree.mockResolvedValueOnce({
      worktreePath: "/workspace/wolf-server/.worktrees/fn-001-abc",
      branch: "fusion/fn-001",
      alreadyAcquired: false,
    });

    const result = await acquireWorkspaceRepoWorktree({
      repoRelPath: "wolf-server",
      workspaceRootDir: "/workspace",
      task: { id: "FN-001", workspaceWorktrees: undefined } as never,
      store: { getTask: vi.fn(), updateTask: vi.fn(), logEntry: vi.fn() } as never,
      settings: {},
    });

    expect(result.alreadyAcquired).toBe(false);
    expect(result.worktreePath).toContain("wolf-server");
  });

  it("returns alreadyAcquired=true when worktree already acquired", async () => {
    mockedAcquireWorkspaceRepoWorktree.mockResolvedValueOnce({
      worktreePath: "/workspace/wolf-server/.worktrees/fn-001-abc",
      branch: "fusion/fn-001",
      alreadyAcquired: true,
    });

    const result = await acquireWorkspaceRepoWorktree({
      repoRelPath: "wolf-server",
      workspaceRootDir: "/workspace",
      task: {
        id: "FN-001",
        workspaceWorktrees: {
          "wolf-server": { worktreePath: "/workspace/wolf-server/.worktrees/fn-001-abc", branch: "fusion/fn-001" },
        },
      } as never,
      store: { getTask: vi.fn(), updateTask: vi.fn(), logEntry: vi.fn() } as never,
      settings: {},
    });

    expect(result.alreadyAcquired).toBe(true);
  });
});

describe("workspace config", () => {
  it("loadWorkspaceConfig returns null for non-workspace", async () => {
    mockedLoadWorkspaceConfig.mockResolvedValueOnce(null);
    const config = await loadWorkspaceConfig("/some/single-repo");
    expect(config).toBeNull();
  });

  it("loadWorkspaceConfig returns config for workspace", async () => {
    mockedLoadWorkspaceConfig.mockResolvedValueOnce(MOCK_WORKSPACE_CONFIG);
    const config = await loadWorkspaceConfig("/some/workspace");
    expect(config?.repos).toEqual(["wolf-server", "wolf-community-frontend-1"]);
  });
});
