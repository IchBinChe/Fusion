import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: id,
    column: "todo",
    status: null,
    paused: false,
    blockedBy: null,
    overlapBlockedBy: null,
    dependencies: [],
    steps: [],
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

describe("SelfHealingManager in-review merge stall deadlock recovery (FN-5488)", () => {
  let tasks: Map<string, Task>;
  let store: TaskStore;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T12:00:00.000Z"));
    tasks = new Map();

    store = {
      getSettings: vi.fn().mockResolvedValue({
        globalPause: false,
        enginePaused: false,
      } as Settings),
      listTasks: vi.fn().mockImplementation(async (opts?: { column?: Task["column"]; includeArchived?: boolean }) => {
        const all = [...tasks.values()];
        if (!opts?.column) return all;
        return all.filter((task) => task.column === opts.column);
      }),
      updateTask: vi.fn().mockImplementation(async (id: string, patch: Partial<Task>) => {
        const current = tasks.get(id);
        if (!current) throw new Error(`Task ${id} missing`);
        tasks.set(id, { ...current, ...patch });
      }),
      logEntry: vi.fn().mockResolvedValue(undefined),
    } as unknown as TaskStore;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears blockedBy for failed in-review blocker with exhausted merge retries", async () => {
    tasks.set("FN-5217", makeTask("FN-5217", {
      column: "in-review",
      status: "failed",
      mergeRetries: 3,
      updatedAt: "2026-05-20T00:00:00.000Z",
    }));
    tasks.set("FN-5119", makeTask("FN-5119", {
      column: "todo",
      blockedBy: "FN-5217",
      status: "queued",
      dependencies: ["FN-5217"],
    }));
    tasks.set("FN-5361", makeTask("FN-5361", {
      column: "todo",
    }));
    tasks.set("FN-5449", makeTask("FN-5449", {
      column: "todo",
      blockedBy: "FN-5217",
      status: "queued",
      dependencies: ["FN-5361", "FN-5217"],
    }));

    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test" });
    const recovered = await manager.clearStaleBlockedBy();

    expect(recovered).toBe(2);
    expect(tasks.get("FN-5119")?.blockedBy).toBeNull();
    expect(tasks.get("FN-5119")?.status).toBeNull();
    expect(tasks.get("FN-5449")?.blockedBy).toBe("FN-5361");
    expect(tasks.get("FN-5449")?.status).toBe("queued");
  });

  it("treats fresh unbacked in-review merging status as stale for fanout", async () => {
    tasks.set("FN-5485", makeTask("FN-5485", {
      column: "in-review",
      status: "merging",
      updatedAt: "2026-05-22T11:58:50.000Z",
    }));
    tasks.set("FN-5486", makeTask("FN-5486", {
      column: "todo",
      blockedBy: "FN-5485",
      status: "queued",
      dependencies: ["FN-5485"],
    }));

    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test",
      staleMergingStatusMinAgeMs: 5 * 60_000,
      staleMergingFanoutMinAgeMs: 15 * 60_000,
      getActiveMergeTaskId: () => null,
    });

    const recovered = await manager.clearStaleBlockedBy();

    expect(recovered).toBe(1);
    expect(tasks.get("FN-5486")?.blockedBy).toBeNull();
    expect(tasks.get("FN-5486")?.status).toBeNull();
  });

  it("preserves overlapBlockedBy when active overlap blocker exists", async () => {
    tasks.set("FN-5485", makeTask("FN-5485", {
      column: "in-review",
      status: "merging",
      updatedAt: "2026-05-22T11:58:50.000Z",
    }));
    tasks.set("FN-OV", makeTask("FN-OV", {
      column: "in-progress",
    }));
    tasks.set("FN-DEP", makeTask("FN-DEP", {
      column: "todo",
      blockedBy: "FN-5485",
      overlapBlockedBy: "FN-OV",
      status: "queued",
      dependencies: ["FN-5485"],
    }));

    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test",
      staleMergingStatusMinAgeMs: 5 * 60_000,
      staleMergingFanoutMinAgeMs: 15 * 60_000,
      getActiveMergeTaskId: () => null,
    });

    await manager.clearStaleBlockedBy();

    expect(tasks.get("FN-DEP")?.blockedBy).toBeNull();
    expect(tasks.get("FN-DEP")?.status).toBe("queued");
    expect(tasks.get("FN-DEP")?.overlapBlockedBy).toBe("FN-OV");
  });
});
