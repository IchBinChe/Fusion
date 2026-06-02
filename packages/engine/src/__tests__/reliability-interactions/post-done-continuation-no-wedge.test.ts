import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import "../executor-test-helpers.js";
import { TaskExecutor } from "../../executor.js";
import { SelfHealingManager } from "../../self-healing.js";
import { mockedCreateFnAgent, resetExecutorMocks } from "../executor-test-helpers.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-5866",
    title: "Prevent executor from continuing post-done sessions",
    description: "regression fixture",
    column: "in-progress",
    status: undefined,
    error: undefined,
    paused: false,
    userPaused: false,
    dependencies: [],
    steps: [{ name: "Implement", status: "pending" as const }],
    currentStep: 0,
    workflowStepResults: [],
    log: [],
    prompt: "# Task\n\n## Steps\n\n### Step 0: Implement\n- [ ] do the work\n",
    branch: "fusion/fn-5866",
    worktree: "/tmp/test/.worktrees/swift-falcon",
    createdAt: "2026-06-02T00:00:00.000Z",
    updatedAt: "2026-06-02T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function createStore(task: Task, settingsOverrides: Record<string, unknown> = {}): TaskStore & EventEmitter {
  const emitter = new EventEmitter() as TaskStore & EventEmitter;
  const audits: any[] = [];

  (emitter as any).__audits = audits;
  (emitter as any).getTask = vi.fn().mockImplementation(async () => task);
  (emitter as any).listTasks = vi.fn().mockImplementation(async ({ column }: { column?: string } = {}) => {
    if (!column) return [task];
    return task.column === column ? [task] : [];
  });
  (emitter as any).getSettings = vi.fn().mockResolvedValue({
    autoMerge: true,
    globalPause: false,
    enginePaused: false,
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 15_000,
    groupOverlappingFiles: false,
    inReviewStallDeadlockThreshold: 3,
    taskStuckTimeoutMs: 60_000,
    ...settingsOverrides,
  });
  (emitter as any).updateTask = vi.fn().mockImplementation(async (_taskId: string, updates: Partial<Task>) => {
    Object.assign(task, updates, { updatedAt: new Date(Date.now()).toISOString() });
    return task;
  });
  (emitter as any).moveTask = vi.fn().mockImplementation(async (_taskId: string, column: Task["column"]) => {
    task.column = column;
    task.updatedAt = new Date(Date.now()).toISOString();
    return task;
  });
  (emitter as any).handoffToReview = vi.fn().mockImplementation(async () => {
    task.column = "in-review";
    task.updatedAt = new Date(Date.now()).toISOString();
    return { ...task, autoMerge: task.autoMerge ?? true };
  });
  (emitter as any).mergeTask = vi.fn().mockResolvedValue(task);
  (emitter as any).logEntry = vi.fn().mockImplementation(async (_taskId: string, action: string, detail?: string) => {
    task.log = task.log ?? [];
    task.log.push({ timestamp: new Date(Date.now()).toISOString(), action, detail } as any);
  });
  (emitter as any).recordRunAuditEvent = vi.fn().mockImplementation(async (event: any) => {
    audits.push(event);
  });
  (emitter as any).appendAgentLog = vi.fn().mockResolvedValue(undefined);
  (emitter as any).getGoalStore = vi.fn().mockReturnValue({ listGoals: vi.fn().mockReturnValue([]) });
  (emitter as any).getFusionDir = vi.fn().mockReturnValue("/tmp/test/.fusion");
  (emitter as any).clearStaleExecutionStartBranchReferences = vi.fn().mockReturnValue([]);
  (emitter as any).listWorkflowSteps = vi.fn().mockResolvedValue([]);
  (emitter as any).getWorkflowStep = vi.fn().mockResolvedValue(undefined);
  (emitter as any).setPluginWorkflowStepTemplates = vi.fn().mockResolvedValue(undefined);
  (emitter as any).updateStep = vi.fn().mockResolvedValue(undefined);
  (emitter as any).parseStepsFromPrompt = vi.fn().mockResolvedValue([]);
  (emitter as any).parseFileScopeFromPrompt = vi.fn().mockResolvedValue([]);
  (emitter as any).getAgentLogs = vi.fn().mockResolvedValue([]);
  (emitter as any).updateSettings = vi.fn().mockResolvedValue(undefined);
  (emitter as any).emit = emitter.emit.bind(emitter);

  return emitter;
}

describe("FN-5866 reliability interactions: post-done continuation no wedge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetExecutorMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps completed work cleanly in-review and avoids stall deadlock after a post-done continuation error", async () => {
    const task = makeTask();
    const store = createStore(task);
    const onComplete = vi.fn();
    const onError = vi.fn();

    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockImplementation(async () => {
          task.steps = [{ name: "Implement", status: "done" as const }];
          task.currentStep = 1;
          task.column = "in-review";
          task.status = undefined;
          task.error = undefined;
          throw new Error("Cannot continue from message role: assistant");
        }),
        dispose: vi.fn(),
        getSessionStats: vi.fn().mockResolvedValue({
          tokens: { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, total: 18 },
        }),
      },
    } as any);

    const executor = new TaskExecutor(store, "/tmp/test", { onComplete, onError });
    await executor.execute(task);

    expect(task.column).toBe("in-review");
    expect(task.status).toBeUndefined();
    expect(task.error).toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalled();
    expect((store.handoffToReview as any).mock.calls.length).toBe(0);
    expect((task.log ?? []).some((entry: any) => entry.action.includes("Post-done session continuation suppressed"))).toBe(true);

    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });
    expect(await manager.surfaceInReviewStalls()).toBe(0);
    expect(task.paused).toBe(false);
    expect(((store as any).__audits as any[]).some((event) => event.mutationType === "task:in-review-stall-deadlock-disposed")).toBe(false);
    manager.stop();
  });

  it("still marks incomplete work failed when the same session error happens before completion", async () => {
    const task = makeTask({ id: "FN-5866-INCOMPLETE" });
    const store = createStore(task);
    const onError = vi.fn();

    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockRejectedValue(new Error("Cannot continue from message role: assistant")),
        dispose: vi.fn(),
        getSessionStats: vi.fn().mockResolvedValue({
          tokens: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, total: 5 },
        }),
      },
    } as any);

    const executor = new TaskExecutor(store, "/tmp/test", { onError });
    await executor.execute(task);

    expect(task.column).toBe("in-review");
    expect(task.status).toBe("failed");
    expect(task.error).toContain("Cannot continue from message role: assistant");
    expect(store.handoffToReview).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
