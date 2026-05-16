import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import { GitHubTrackingReconciler, RECONCILE_CONCURRENCY_LIMIT } from "../github-tracking-reconciler.js";

const { mockGetIssue, mockSetIssueState } = vi.hoisted(() => ({
  mockGetIssue: vi.fn(),
  mockSetIssueState: vi.fn(),
}));

const { mockResolveGithubTrackingAuth } = vi.hoisted(() => ({
  mockResolveGithubTrackingAuth: vi.fn(),
}));

vi.mock("../github.js", () => ({
  GitHubClient: vi.fn().mockImplementation(() => ({
    getIssue: (...args: unknown[]) => mockGetIssue(...args),
    setIssueState: (...args: unknown[]) => mockSetIssueState(...args),
  })),
}));

vi.mock("../github-auth.js", () => ({
  resolveGithubTrackingAuth: (...args: unknown[]) => mockResolveGithubTrackingAuth(...args),
}));

function createStore(tasks: Array<Record<string, unknown>>): TaskStore {
  return {
    listTasks: vi.fn().mockResolvedValue(tasks),
    logEntry: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue({ githubAuthMode: "token", githubAuthToken: "ghp_test" }),
    getGlobalSettingsStore: vi.fn(() => ({ getSettings: vi.fn().mockResolvedValue({}) })),
  } as unknown as TaskStore;
}

describe("GitHubTrackingReconciler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("closes open issues for done tracked tasks", async () => {
    mockResolveGithubTrackingAuth.mockReturnValue({ ok: true, auth: { mode: "token", token: "ghp_test" } });
    mockGetIssue.mockResolvedValue({ state: "open" });
    const store = createStore([{ id: "FN-1", status: "done", githubTracking: { enabled: true, issue: { owner: "o", repo: "r", number: 1 } } }]);

    const result = await new GitHubTrackingReconciler().reconcile(store);

    expect(mockSetIssueState).toHaveBeenCalledWith("o", "r", 1, "closed", "completed");
    expect(result.closed).toBe(1);
  });

  it("skips closed issues and invalid tracking tasks", async () => {
    mockResolveGithubTrackingAuth.mockReturnValue({ ok: true, auth: { mode: "token", token: "ghp_test" } });
    mockGetIssue.mockResolvedValue({ state: "closed" });
    const store = createStore([
      { id: "FN-1", status: "done", githubTracking: { enabled: true, issue: { owner: "o", repo: "r", number: 1 } } },
      { id: "FN-2", status: "done", githubTracking: { enabled: false, issue: { owner: "o", repo: "r", number: 2 } } },
      { id: "FN-3", status: "done", githubTracking: { enabled: true, issue: { owner: "o", repo: "", number: 3 } } },
      { id: "FN-4", status: "todo", githubTracking: { enabled: true, issue: { owner: "o", repo: "r", number: 4 } } },
    ]);

    const result = await new GitHubTrackingReconciler().reconcile(store);

    expect(result.closed).toBe(0);
    expect(result.skipped).toBe(3);
    expect(mockSetIssueState).not.toHaveBeenCalled();
  });

  it("logs and continues on per-issue errors", async () => {
    mockResolveGithubTrackingAuth.mockReturnValue({ ok: true, auth: { mode: "token", token: "ghp_test" } });
    mockGetIssue.mockRejectedValueOnce(new Error("boom"));
    mockGetIssue.mockResolvedValueOnce({ state: "open" });
    const store = createStore([
      { id: "FN-1", status: "done", githubTracking: { enabled: true, issue: { owner: "o", repo: "r", number: 1 } } },
      { id: "FN-2", status: "done", githubTracking: { enabled: true, issue: { owner: "o", repo: "r", number: 2 } } },
    ]);

    const result = await new GitHubTrackingReconciler().reconcile(store);

    expect(result.errors).toBe(1);
    expect(result.closed).toBe(1);
    expect((store.logEntry as any)).toHaveBeenCalledWith("FN-1", "Failed to reconcile GitHub tracking issue", "boom");
  });

  it("skips and logs when auth is unavailable", async () => {
    mockResolveGithubTrackingAuth.mockReturnValue({ ok: false, message: "no auth" });
    const store = createStore([{ id: "FN-1", status: "done", githubTracking: { enabled: true, issue: { owner: "o", repo: "r", number: 1 } } }]);

    const result = await new GitHubTrackingReconciler().reconcile(store);

    expect(result.skipped).toBe(1);
    expect((store.logEntry as any)).toHaveBeenCalledWith("FN-1", "Skipped GitHub tracking issue reconciliation", "no auth");
  });

  it("respects concurrency cap", async () => {
    mockResolveGithubTrackingAuth.mockReturnValue({ ok: true, auth: { mode: "token", token: "ghp_test" } });
    let inFlight = 0;
    let maxInFlight = 0;
    mockGetIssue.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return { state: "closed" };
    });

    const tasks = Array.from({ length: 10 }, (_, i) => ({
      id: `FN-${i + 1}`,
      status: "done",
      githubTracking: { enabled: true, issue: { owner: "o", repo: "r", number: i + 1 } },
    }));

    await new GitHubTrackingReconciler().reconcile(createStore(tasks));
    expect(maxInFlight).toBeLessThanOrEqual(RECONCILE_CONCURRENCY_LIMIT);
  });
});
