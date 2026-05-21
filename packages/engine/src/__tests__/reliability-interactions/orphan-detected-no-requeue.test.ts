import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../../self-healing.js";
import { activeSessionRegistry, executingTaskLock } from "../../active-session-registry.js";

function git(cwd: string, command: string): string {
  return execSync(`git ${command}`, { cwd, encoding: "utf8" }).trim();
}

describe("FN-5337 reliability interactions: orphan detected no requeue", () => {
  let rootDir = "";
  let store: TaskStore;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T12:00:00.000Z"));
    activeSessionRegistry.clear();
    executingTaskLock._clearForTest();
    rootDir = mkdtempSync(join(tmpdir(), "fn-5337-reliability-"));
    git(rootDir, "init -b main");
    git(rootDir, "config user.name 'Fusion'");
    git(rootDir, "config user.email 'hi@runfusion.ai'");
    writeFileSync(join(rootDir, "README.md"), "root\n");
    git(rootDir, "add README.md");
    git(rootDir, "commit -m 'init'");
    mkdirSync(join(rootDir, ".worktrees"), { recursive: true });
    store = new TaskStore(rootDir, undefined, { inMemoryDb: false });
  });

  afterEach(() => {
    activeSessionRegistry.clear();
    executingTaskLock._clearForTest();
    try { store?.close(); } catch {}
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  async function createInProgressTask(title: string) {
    const task = await store.createTask({ title, description: title });
    await store.moveTask(task.id, "todo");
    await store.moveTask(task.id, "in-progress");
    return task.id;
  }

  async function orphanEvents(taskId: string) {
    return store.getRunAuditEvents({ taskId, mutationType: "task:orphan-detected-no-action" });
  }

  it("Scenario A: FN-5279 repro shape emits no-action event without lifecycle mutation", async () => {
    const id = await createInProgressTask("fn-5279 repro");
    const liveWorktree = join(rootDir, ".worktrees", `${id.toLowerCase()}-live`);
    const branch = `fusion/${id.toLowerCase()}`;
    git(rootDir, `worktree add -b ${branch} ${liveWorktree}`);
    activeSessionRegistry.registerPath(liveWorktree, { taskId: id, kind: "executor", ownerKey: "run-1" });
    await store.updateTask(id, { branch: null, worktree: null });
    vi.setSystemTime(new Date("2026-05-20T12:07:00.000Z"));

    const manager = new SelfHealingManager(store, { rootDir, getExecutingTaskIds: () => new Set<string>() });
    const recovered = await manager.recoverOrphanedExecutions();
    const task = await store.getTask(id);
    const events = await orphanEvents(id);

    expect(recovered).toBe(0);
    expect(task?.column).toBe("in-progress");
    expect(task?.branch ?? null).toBeNull();
    expect(task?.worktree ?? null).toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0]?.mutationType).toBe("task:orphan-detected-no-action");
    manager.stop();
  });

  it("Scenario B: worktree exists with no active session emits no-action reason and no move", async () => {
    const id = await createInProgressTask("existing worktree no session");
    const worktree = join(rootDir, ".worktrees", `${id.toLowerCase()}-stale`);
    const branch = `fusion/${id.toLowerCase()}`;
    git(rootDir, `worktree add -b ${branch} ${worktree}`);
    await store.updateTask(id, { branch, worktree });
    vi.setSystemTime(new Date("2026-05-20T12:07:00.000Z"));

    const manager = new SelfHealingManager(store, { rootDir, getExecutingTaskIds: () => new Set<string>() });
    await manager.recoverOrphanedExecutions();
    const task = await store.getTask(id);
    const events = await orphanEvents(id);

    expect(task?.column).toBe("in-progress");
    expect(task?.branch).toBe(branch);
    expect(task?.worktree).toBe(worktree);
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toEqual(expect.objectContaining({ reason: "worktree-exists-no-active-session" }));
    manager.stop();
  });

  it("Scenario C: missing worktree emits no-action then limbo recovery handles proof-based case", async () => {
    const id = await createInProgressTask("missing worktree");
    await store.updateTask(id, {
      branch: null,
      worktree: join(rootDir, ".worktrees", `${id.toLowerCase()}-missing`),
      steps: [{ name: "step", status: "pending" }],
          });
    vi.setSystemTime(new Date("2026-05-20T12:07:00.000Z"));

    const manager = new SelfHealingManager(store, { rootDir, getExecutingTaskIds: () => new Set<string>() });
    const orphanRecovered = await manager.recoverOrphanedExecutions();
    const limboRecovered = await manager.recoverInProgressLimbo();
    const task = await store.getTask(id);

    expect(orphanRecovered).toBe(0);
    expect(limboRecovered).toBe(1);
    expect(task?.column).toBe("todo");
    expect((await orphanEvents(id)).length).toBe(1);
    manager.stop();
  });

  it("Scenario D: ordering with FN-5219 remains proof-path owned", async () => {
    const id = await createInProgressTask("ordering");
    await store.updateTask(id, {
      branch: null,
      worktree: join(rootDir, ".worktrees", `${id.toLowerCase()}-missing`),
      steps: [{ name: "step", status: "pending" }],
          });
    vi.setSystemTime(new Date("2026-05-20T12:07:00.000Z"));

    const manager = new SelfHealingManager(store, { rootDir, getExecutingTaskIds: () => new Set<string>() });
    const orphanFirst = await manager.recoverOrphanedExecutions();
    const limboSecond = await manager.recoverInProgressLimbo();
    const task = await store.getTask(id);
    expect(orphanFirst).toBe(0);
    expect(limboSecond).toBe(1);
    expect(task?.column).toBe("todo");
    expect(await orphanEvents(id)).toHaveLength(1);
    manager.stop();
  });

  it("Scenario E: in-review tasks are ignored", async () => {
    const id = await createInProgressTask("in-review ignore");
    await store.moveTask(id, "in-review");
    await store.updateTask(id, {});
    vi.setSystemTime(new Date("2026-05-20T12:07:00.000Z"));
    const manager = new SelfHealingManager(store, { rootDir, getExecutingTaskIds: () => new Set<string>() });
    await manager.recoverOrphanedExecutions();
    expect(await orphanEvents(id)).toHaveLength(0);
    manager.stop();
  });

  it("Scenario F: branch-cleared task with live branch remains unchanged except annotation", async () => {
    const id = await createInProgressTask("branch cleared");
    const worktree = join(rootDir, ".worktrees", `${id.toLowerCase()}-branch`);
    git(rootDir, `worktree add -b fusion/${id.toLowerCase()} ${worktree}`);
    await store.updateTask(id, { branch: null, worktree: null });
    vi.setSystemTime(new Date("2026-05-20T12:07:00.000Z"));
    const manager = new SelfHealingManager(store, { rootDir, getExecutingTaskIds: () => new Set<string>() });
    await manager.recoverOrphanedExecutions();
    const task = await store.getTask(id);
    expect(task?.branch ?? null).toBeNull();
    expect(await orphanEvents(id)).toHaveLength(1);
    manager.stop();
  });

  it("Scenario G: lease manager is untouched", async () => {
    const id = await createInProgressTask("lease untouched");
    await store.updateTask(id, { worktree: null, checkedOutBy: "agent-x" });
    vi.setSystemTime(new Date("2026-05-20T12:07:00.000Z"));
    const recoverAbandonedLease = vi.fn();
    const reconcileLeaseRow = vi.fn();
    const manager = new SelfHealingManager(store, {
      rootDir,
      getExecutingTaskIds: () => new Set<string>(),
      leaseManager: { recoverAbandonedLease, reconcileLeaseRow } as any,
    });
    await manager.recoverOrphanedExecutions();
    expect(recoverAbandonedLease).not.toHaveBeenCalled();
    expect(reconcileLeaseRow).not.toHaveBeenCalled();
    manager.stop();
  });

  it("Scenario H: re-sweep emits one event per candidate per sweep", async () => {
    const id = await createInProgressTask("idempotent re-sweep");
    await store.updateTask(id, { worktree: null });
    vi.setSystemTime(new Date("2026-05-20T12:07:00.000Z"));
    const manager = new SelfHealingManager(store, { rootDir, getExecutingTaskIds: () => new Set<string>() });
    await manager.recoverOrphanedExecutions();
    await manager.recoverOrphanedExecutions();
    expect(await orphanEvents(id)).toHaveLength(2);
    manager.stop();
  });
});
