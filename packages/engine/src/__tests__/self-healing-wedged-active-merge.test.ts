import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";

/*
FNXC:MergeQueue 2026-07-15-09:50:
Self-healing must reclaim a wedged in-process active merge when the AI merge review pass hangs (status=reviewing / merger agent silence) so the single-flight pump is not stuck with no merging badge on the board.
*/

function createTask(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: id,
    description: id,
    column: "in-review",
    status: "reviewing",
    paused: false,
    blockedBy: null,
    dependencies: [],
    steps: [{ name: "Ship", status: "done" }],
    log: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("SelfHealingManager wedged active merge recovery", () => {
  let tasks: Map<string, Record<string, unknown>>;
  let store: TaskStore;
  let agentLogs: Array<{ agent?: string; timestamp?: string; type?: string; text?: string }>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T01:00:00.000Z"));
    tasks = new Map();
    agentLogs = [];

    const wedged = createTask("FN-WEDGE");
    tasks.set("FN-WEDGE", wedged);

    store = {
      getSettings: vi.fn().mockResolvedValue({
        globalPause: false,
        enginePaused: false,
        autoMerge: true,
        taskStuckTimeoutMs: 15 * 60_000,
      } as unknown as Settings),
      listTasks: vi.fn().mockImplementation(async (options?: { column?: string }) => {
        const all = Array.from(tasks.values());
        if (!options?.column) return all;
        return all.filter((task) => task.column === options.column);
      }),
      getTask: vi.fn().mockImplementation(async (id: string) => tasks.get(id) ?? null),
      updateTask: vi.fn().mockImplementation(async (id: string, patch: Record<string, unknown>) => {
        const current = tasks.get(id);
        if (!current) throw new Error(`Task ${id} missing`);
        tasks.set(id, { ...current, ...patch });
      }),
      logEntry: vi.fn().mockResolvedValue(undefined),
      getAgentLogs: vi.fn().mockImplementation(async () => agentLogs),
      getCompletionHandoffAcceptedMarker: vi.fn().mockReturnValue(null),
      parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
    } as unknown as TaskStore;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not reclaim a live active merge with recent merger agent activity", async () => {
    agentLogs = [
      { agent: "merger", timestamp: "2026-01-01T00:55:00.000Z", type: "tool", text: "bash" },
    ];
    const abortActiveMerge = vi.fn().mockReturnValue(true);
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      getActiveMergeTaskId: () => "FN-WEDGE",
      getActiveMergeStartedAtMs: () => Date.parse("2026-01-01T00:00:00.000Z"),
      abortActiveMerge,
    });

    const recovered = await manager.recoverWedgedActiveMerge();
    expect(recovered).toBe(0);
    expect(abortActiveMerge).not.toHaveBeenCalled();
    manager.stop();
  });

  it("reclaims active merge after merger agent silence past stuck timeout", async () => {
    // Last merger activity 30 minutes ago; stuck timeout is 15 minutes.
    agentLogs = [
      { agent: "merger", timestamp: "2026-01-01T00:30:00.000Z", type: "tool", text: "fn_task_show" },
      { agent: "executor", timestamp: "2026-01-01T00:59:00.000Z", type: "text", text: "noise" },
    ];
    const abortActiveMerge = vi.fn().mockReturnValue(true);
    const enqueueMerge = vi.fn().mockReturnValue(true);
    const clearMergeActive = vi.fn();
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      getActiveMergeTaskId: () => "FN-WEDGE",
      getActiveMergeStartedAtMs: () => Date.parse("2026-01-01T00:00:00.000Z"),
      abortActiveMerge,
      enqueueMerge,
      clearMergeActive,
    });

    const recovered = await manager.recoverWedgedActiveMerge();
    expect(recovered).toBe(1);
    expect(abortActiveMerge).toHaveBeenCalledWith("FN-WEDGE", "wedged-active-merge-no-merger-progress");
    expect(clearMergeActive).toHaveBeenCalledWith("FN-WEDGE");
    expect(enqueueMerge).toHaveBeenCalledWith("FN-WEDGE");
    expect(tasks.get("FN-WEDGE")?.status).toBeNull();
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-WEDGE",
      expect.stringContaining("wedged active merge reclaimed"),
    );
    manager.stop();
  });

  it("recoverInterruptedMergingTasks includes AI-merge reviewing status and aborts the live owner", async () => {
    agentLogs = [
      { agent: "merger", timestamp: "2026-01-01T00:20:00.000Z", type: "tool", text: "bash" },
    ];
    const abortActiveMerge = vi.fn().mockReturnValue(true);
    const enqueueMerge = vi.fn().mockReturnValue(true);
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      getActiveMergeTaskId: () => "FN-WEDGE",
      getActiveMergeStartedAtMs: () => Date.parse("2026-01-01T00:00:00.000Z"),
      abortActiveMerge,
      enqueueMerge,
      clearMergeActive: vi.fn(),
    });

    const recovered = await manager.recoverInterruptedMergingTasks();
    expect(recovered).toBe(1);
    expect(abortActiveMerge).toHaveBeenCalledWith("FN-WEDGE", "recover-interrupted-merging-wedged-owner");
    expect(enqueueMerge).toHaveBeenCalledWith("FN-WEDGE");
    expect(tasks.get("FN-WEDGE")?.status).toBeNull();
    manager.stop();
  });

  it("reclaims when agent logs are empty but claim wall-clock exceeds stuck timeout", async () => {
    agentLogs = [];
    const abortActiveMerge = vi.fn().mockReturnValue(true);
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      getActiveMergeTaskId: () => "FN-WEDGE",
      // Claimed 40 minutes ago at system time 01:00
      getActiveMergeStartedAtMs: () => Date.parse("2026-01-01T00:20:00.000Z"),
      abortActiveMerge,
      enqueueMerge: vi.fn().mockReturnValue(true),
      clearMergeActive: vi.fn(),
    });

    const recovered = await manager.recoverWedgedActiveMerge();
    expect(recovered).toBe(1);
    expect(abortActiveMerge).toHaveBeenCalled();
    manager.stop();
  });
});
