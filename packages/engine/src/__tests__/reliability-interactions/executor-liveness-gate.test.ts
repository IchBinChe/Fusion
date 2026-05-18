import { beforeEach, describe, expect, it, vi } from "vitest";
import "../executor-test-helpers.js";
import { TaskExecutor } from "../../executor.js";
import { createFnAgent } from "../../pi.js";
import * as worktreePool from "../../worktree-pool.js";
import * as worktreeAcquisition from "../../worktree-acquisition.js";
import { createMockStore, mockedExecSync, resetExecutorMocks } from "../executor-test-helpers.js";

const mockedCreateFnAgent = vi.mocked(createFnAgent);

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-4935-T",
    title: "Liveness gate",
    description: "",
    column: "in-progress",
    dependencies: [],
    worktree: "/repo/.worktrees/stale-path",
    branch: "fusion/fn-4935-t",
    taskDoneRetryCount: 0,
    steps: [{ name: "Step 1", status: "in-progress" as const }],
    currentStep: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as any;
}

describe("reliability interactions: FN-4935 executor liveness gate", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetExecutorMocks();
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("abc123\n");
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/new-path\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-4935-t\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("1\n");
      return Buffer.from("");
    });
    mockedCreateFnAgent.mockImplementation(async () => ({
      session: { prompt: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() },
    }) as any);
  });

  it("FN-4935 regression: fresh post-create acquisition does not emit not_usable_task_worktree startup failure", async () => {
    const classifySpy = vi.spyOn(worktreePool, "classifyTaskWorktree").mockResolvedValue({ ok: false, classification: "unregistered", reason: "not registered in git worktree list" });
    vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockResolvedValue({
      worktreePath: "/repo/.worktrees/new-path",
      branch: "fusion/fn-4935-t",
      source: "fresh",
      hydrated: true,
      isResume: false,
    });

    const store = createMockStore();
    const executor = new TaskExecutor(store as any, "/repo");
    await executor.execute(makeTask());

    expect(classifySpy).not.toHaveBeenCalled();
    expect(mockedCreateFnAgent).toHaveBeenCalled();
    expect(
      store.logEntry.mock.calls.some(
        (call: unknown[]) => call[0] === "FN-4935-T" && typeof call[1] === "string" && call[1].includes("not_usable_task_worktree"),
      ),
    ).toBe(false);
  });

  it("FN-4935 regression guard: pooled unusable worktree still fails with recoverable unregistered classification", async () => {
    vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockResolvedValue({
      worktreePath: "/repo/.worktrees/new-path",
      branch: "fusion/fn-4935-t",
      source: "pool",
      hydrated: true,
      isResume: false,
    });
    vi.spyOn(worktreePool, "classifyTaskWorktree").mockResolvedValue({ ok: false, classification: "unregistered", reason: "not registered in git worktree list" });
    vi.spyOn(worktreePool, "describeRegisteredWorktrees").mockResolvedValue({
      rawOutput: "",
      canonicalized: ["/repo/.worktrees/a", "/repo/.worktrees/b"],
    });

    const store = createMockStore();
    const events: any[] = [];
    store.recordRunAuditEvent = vi.fn(async (event: any) => events.push(event));

    const executor = new TaskExecutor(store as any, "/repo");
    await executor.execute(makeTask({ sessionFile: null }));

    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-4935-T",
      expect.stringContaining("not_usable_task_worktree:unregistered"),
      undefined,
      expect.anything(),
    );
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-4935-T",
      expect.stringContaining("registered=[/repo/.worktrees/a, /repo/.worktrees/b]"),
      undefined,
      expect.anything(),
    );
    expect(store.moveTask).toHaveBeenCalledWith("FN-4935-T", "todo", { preserveProgress: true });
    expect(store.updateTask).toHaveBeenCalledWith("FN-4935-T", expect.objectContaining({ taskDoneRetryCount: 1 }));
    expect(events.some((event) => (event.type === "worktree:incomplete-detected" || event.mutationType === "worktree:incomplete-detected") && event.metadata?.source === "executor-liveness-gate" && event.metadata?.terminalAction === "requeue-todo")).toBe(true);
  });

  it.each([
    "missing",
    "incomplete",
    "unregistered",
    "outside-work-tree",
  ] as const)("formats failure message for %s", async (classification) => {
    vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockResolvedValue({
      worktreePath: "/repo/.worktrees/new-path",
      branch: "fusion/fn-4935-t",
      source: "existing",
      hydrated: true,
      isResume: true,
    });
    vi.spyOn(worktreePool, "classifyTaskWorktree").mockResolvedValue({ ok: false, classification, reason: `reason-${classification}` });

    const store = createMockStore();
    const executor = new TaskExecutor(store as any, "/repo");
    await executor.execute(makeTask());

    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-4935-T",
      expect.stringContaining(`not_usable_task_worktree:${classification} (reason-${classification})`),
      undefined,
      expect.anything(),
    );
  });

  it("parks in-review at retry cap", async () => {
    vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockResolvedValue({
      worktreePath: "/repo/.worktrees/new-path",
      branch: "fusion/fn-4935-t",
      source: "pool",
      hydrated: true,
      isResume: false,
    });
    vi.spyOn(worktreePool, "classifyTaskWorktree").mockResolvedValue({ ok: false, classification: "incomplete", reason: "missing .git metadata" });

    const store = createMockStore();
    const events: any[] = [];
    store.recordRunAuditEvent = vi.fn(async (event: any) => events.push(event));

    const executor = new TaskExecutor(store as any, "/repo");
    await executor.execute(makeTask({ taskDoneRetryCount: 999, sessionFile: null }));

    expect(store.moveTask).toHaveBeenCalledWith("FN-4935-T", "in-review");
    expect(events.some((event) => (event.type === "worktree:incomplete-detected" || event.mutationType === "worktree:incomplete-detected") && event.metadata?.terminalAction === "park-in-review")).toBe(true);
  });

  it("continues when registered snapshot helper fails", async () => {
    vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockResolvedValue({
      worktreePath: "/repo/.worktrees/new-path",
      branch: "fusion/fn-4935-t",
      source: "pool",
      hydrated: true,
      isResume: false,
    });
    vi.spyOn(worktreePool, "classifyTaskWorktree").mockResolvedValue({ ok: false, classification: "unregistered", reason: "not registered in git worktree list" });
    vi.spyOn(worktreePool, "describeRegisteredWorktrees").mockRejectedValueOnce(new Error("boom"));

    const store = createMockStore();
    const executor = new TaskExecutor(store as any, "/repo");
    await executor.execute(makeTask({ sessionFile: null }));

    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-4935-T",
      expect.stringContaining("not_usable_task_worktree:unregistered"),
      undefined,
      expect.anything(),
    );
  });
});
