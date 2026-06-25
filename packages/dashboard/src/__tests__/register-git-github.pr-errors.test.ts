// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { createServer } from "../server.js";
import { request as performRequest } from "../test-request.js";
import { GitHubClient } from "../github.js";

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-001",
    title: "Task",
    description: "desc",
    column: "in-review",
    status: "in-review",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    prInfo: {
      url: "https://github.com/owner/repo/pull/1",
      number: 1,
      status: "open",
      title: "PR",
      headBranch: "feature",
      baseBranch: "main",
      commentCount: 0,
    },
    comments: [],
    ...overrides,
  } as Task;
}

function createStore(task: Task): TaskStore {
  return {
    getTask: vi.fn().mockResolvedValue(task),
    updatePrInfo: vi.fn().mockResolvedValue(undefined),
    logEntry: vi.fn().mockResolvedValue(undefined),
    getRootDir: vi.fn().mockReturnValue("/tmp/project"),
    applyPrMergedTransition: vi.fn().mockResolvedValue(undefined),
    listTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(),
    moveTask: vi.fn().mockResolvedValue(task),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    mergeTask: vi.fn(),
    archiveTask: vi.fn(),
    unarchiveTask: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({}),
    updateSettings: vi.fn(),
    getAgentLogs: vi.fn().mockResolvedValue([]),
    addSteeringComment: vi.fn(),
    updateIssueInfo: vi.fn(),
    addComment: vi.fn().mockResolvedValue(task),
    upsertTaskDocument: vi.fn().mockResolvedValue({ key: "review-feedback" }),
    getFusionDir: vi.fn().mockReturnValue("/tmp/project/.fusion"),
    getDatabase: vi.fn().mockReturnValue({
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({ run: vi.fn().mockReturnValue({ changes: 0 }), get: vi.fn(), all: vi.fn().mockReturnValue([]) }),
    }),
    getMissionStore: vi.fn().mockReturnValue({ listMissions: vi.fn().mockReturnValue([]) }),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as TaskStore;
}

describe("PR route structured GitHub errors", () => {
  const originalRepoEnv = process.env.GITHUB_REPOSITORY;

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalRepoEnv === undefined) {
      delete process.env.GITHUB_REPOSITORY;
    } else {
      process.env.GITHUB_REPOSITORY = originalRepoEnv;
    }
  });

  it("maps not-authenticated to 401 with githubError details", async () => {
    process.env.GITHUB_REPOSITORY = "owner/repo";
    const task = createTask({ prInfo: undefined });
    vi.spyOn(GitHubClient.prototype, "findPrForBranch").mockRejectedValue(new Error("authentication required 401"));

    const app = createServer(createStore(task));
    const response = await performRequest(app, "POST", "/api/tasks/FN-001/pr/create", JSON.stringify({ title: "PR title", body: "PR body" }), { "content-type": "application/json" });

    expect(response.status).toBe(401);
    expect(response.body.details.githubError.code).toBe("not-authenticated");
    expect(response.body.details.githubError.hint).toContain("gh auth login");
  });

  it("maps rate-limited to 429 with retryAfterMs", async () => {
    const task = createTask();
    vi.spyOn(GitHubClient.prototype, "getPrReviewSnapshot").mockRejectedValue({ message: "403 API rate limit exceeded", stderr: "Retry-After: 7" });

    const app = createServer(createStore(task));
    const response = await performRequest(app, "POST", "/api/tasks/FN-001/pr/refresh", "{}", { "content-type": "application/json" });

    expect(response.status).toBe(429);
    expect(response.body.details.githubError.code).toBe("rate-limited");
    expect(response.body.details.githubError.retryAfterMs).toBe(7000);
  });

  it("maps unknown errors to 502 and retryable true", async () => {
    const task = createTask();
    vi.spyOn(GitHubClient.prototype, "getPrReviewSnapshot").mockRejectedValue(new Error("kaboom"));

    const app = createServer(createStore(task));
    const response = await performRequest(app, "POST", "/api/tasks/FN-001/pr/refresh", "{}", { "content-type": "application/json" });

    expect(response.status).toBe(502);
    expect(response.body.details.githubError.code).toBe("unknown");
    expect(response.body.details.githubError.retryable).toBe(true);
  });
});
