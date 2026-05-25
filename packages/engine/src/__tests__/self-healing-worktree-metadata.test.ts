import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const { logger } = vi.hoisted(() => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../logger.js", () => ({
  createLogger: vi.fn(() => logger),
}));

import type { Task } from "@fusion/core";
import { TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";

function git(cwd: string, command: string): string {
  return execSync(`git ${command}`, { cwd, encoding: "utf8" }).trim();
}

function makeSlimTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: id,
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

describe("self-healing worktree metadata reconcile", () => {
  let rootDir = "";
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "fn-4962-"));
    git(rootDir, "init -b main");
    git(rootDir, "config user.name 'Fusion'");
    git(rootDir, "config user.email 'hi@runfusion.ai'");
    writeFileSync(join(rootDir, "README.md"), "root\n");
    git(rootDir, "add README.md");
    git(rootDir, "commit -m 'init'");

    store = new TaskStore(rootDir, undefined, { inMemoryDb: false });
    await store.createTask({
      title: "FN-4913 reproduction",
      description: "repro",
    });
  });

  afterEach(() => {
    try {
      store?.close();
    } catch {
      // noop
    }
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("keeps reconcile-task-worktree-metadata ordered before reclaim-stale-active-branches in startup and maintenance", () => {
    const selfHealingPath = fileURLToPath(new URL("../self-healing.ts", import.meta.url));
    const source = readFileSync(selfHealingPath, "utf8");

    const startupSlice = source.slice(
      source.indexOf("const steps:"),
      source.indexOf("for (const step of steps)"),
    );
    expect(startupSlice.indexOf('"reconcile-task-worktree-metadata"')).toBeGreaterThan(-1);
    expect(startupSlice.indexOf('"reclaim-stale-active-branches"')).toBeGreaterThan(-1);
    expect(startupSlice.indexOf('"reconcile-task-worktree-metadata"')).toBeLessThan(
      startupSlice.indexOf('"reclaim-stale-active-branches"'),
    );

    const maintenanceSlice = source.slice(
      source.indexOf("const batch2Fns:"),
      source.indexOf("for (const fn of batch2Fns)"),
    );
    expect(maintenanceSlice.indexOf('"reconcile-task-worktree-metadata"')).toBeGreaterThan(-1);
    expect(maintenanceSlice.indexOf('"reclaim-stale-active-branches"')).toBeGreaterThan(-1);
    expect(maintenanceSlice.indexOf('"reconcile-task-worktree-metadata"')).toBeLessThan(
      maintenanceSlice.indexOf('"reclaim-stale-active-branches"'),
    );
  });

  it("rebinds stale task.worktree + null branch to live fusion/<id> worktree", async () => {
    const [task] = await store.listTasks();
    expect(task).toBeTruthy();

    const stalePath = join(rootDir, ".worktrees", "misty-grove");
    const livePath = join(rootDir, ".worktrees", "sleek-stone");
    mkdirSync(join(rootDir, ".worktrees"), { recursive: true });

    const branch = `fusion/${task.id.toLowerCase()}`;
    git(rootDir, `branch ${branch}`);
    git(rootDir, `worktree add ${livePath} ${branch}`);
    writeFileSync(join(livePath, "feature.txt"), "changed\n");
    git(livePath, "add feature.txt");
    git(livePath, "commit -m 'feature commit'");

    await store.moveTask(task.id, "todo");
    await store.moveTask(task.id, "in-progress");
    await store.moveTask(task.id, "in-review");
    await store.updateTask(task.id, {
      worktree: stalePath,
      branch: null,
    });

    const auditSpy = vi.spyOn(store, "recordRunAuditEvent");
    const manager = new SelfHealingManager(store, {
      rootDir,
      getExecutingTaskIds: () => new Set<string>(),
    });

    await (manager as any).reconcileTaskWorktreeMetadata();

    const canonicalLivePath = realpathSync(livePath);
    const updated = await store.getTask(task.id);
    expect(updated?.worktree).toBe(canonicalLivePath);
    expect(updated?.branch).toBe(branch);

    const taskJson = JSON.parse(
      readFileSync(join(rootDir, ".fusion", "tasks", task.id, "task.json"), "utf8"),
    ) as { worktree?: string | null; branch?: string | null };
    expect(taskJson.worktree).toBe(canonicalLivePath);
    expect(taskJson.branch).toBe(branch);

    expect(logger.log).toHaveBeenCalled();
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ mutationType: "task:auto-recover-worktree-metadata-rebound" }),
    );
  });
});

describe("reconcileTaskWorktreeMetadata matrix", () => {
  it("skips done/archived and executing tasks", async () => {
    const tasks = [
      makeSlimTask("FN-100", { column: "done", worktree: "/missing", branch: undefined }),
      makeSlimTask("FN-101", { column: "archived", worktree: "/missing", branch: undefined }),
      makeSlimTask("FN-102", { column: "todo", worktree: "/missing", branch: undefined }),
    ];

    const store = Object.assign(new EventEmitter(), {
      getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false })),
      listTasks: vi.fn(async () => tasks),
      updateTask: vi.fn(async () => undefined),
      recordRunAuditEvent: vi.fn(async () => undefined),
    }) as unknown as TaskStore;

    const manager = new SelfHealingManager(store, {
      rootDir: process.cwd(),
      getExecutingTaskIds: () => new Set(["FN-102"]),
    });

    const repaired = await manager.reconcileTaskWorktreeMetadata();
    expect(repaired).toBe(0);
    expect((store as any).updateTask).not.toHaveBeenCalled();
  });
});

describe("FN-5256 reconcileTaskWorktreeMetadata reliability", () => {
  let rootDir = "";
  let store: TaskStore;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "fn-5256-"));
    git(rootDir, "init -b main");
    git(rootDir, "config user.name 'Fusion'");
    git(rootDir, "config user.email 'hi@runfusion.ai'");
    writeFileSync(join(rootDir, "README.md"), "root\n");
    git(rootDir, "add README.md");
    git(rootDir, "commit -m 'init'");

    store = new TaskStore(rootDir, undefined, { inMemoryDb: false });
  });

  afterEach(() => {
    try {
      store?.close();
    } catch {
      // noop
    }
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("FN-5256: realpath-normalizes both sides so a symlinked task.worktree is not falsely flagged stale", async () => {
    await store.createTask({ title: "FN-5256 symlink", description: "symlink case" });
    const [task] = await store.listTasks();

    mkdirSync(join(rootDir, ".worktrees"), { recursive: true });
    const realWorktreeDir = join(realpathSync(rootDir), ".worktrees", "real-leaf");
    const branch = `fusion/${task.id.toLowerCase()}`;
    git(rootDir, `branch ${branch}`);
    git(rootDir, `worktree add ${realWorktreeDir} ${branch}`);

    // Create a symlink that points at the registered worktree's parent. The task
    // metadata persists the symlinked path; the registry will surface realpath.
    const symlinkParent = join(rootDir, ".worktrees-symlink");
    symlinkSync(join(rootDir, ".worktrees"), symlinkParent, "dir");
    const symlinkedTaskWorktree = join(symlinkParent, "real-leaf");

    await store.updateTask(task.id, { worktree: symlinkedTaskWorktree, branch });

    const auditSpy = vi.spyOn(store, "recordRunAuditEvent");
    const manager = new SelfHealingManager(store, {
      rootDir,
      getExecutingTaskIds: () => new Set<string>(),
    });

    const repaired = await (manager as any).reconcileTaskWorktreeMetadata();
    expect(repaired).toBe(0);

    const updated = await store.getTask(task.id);
    expect(updated?.worktree).toBe(symlinkedTaskWorktree);
    expect(updated?.branch).toBe(branch);
    expect(auditSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ mutationType: "task:auto-recover-worktree-metadata-cleared" }),
    );
  });

  it("FN-5256: refuses to clear worktree metadata for an in-progress task with a stale-flagged worktree", async () => {
    await store.createTask({ title: "FN-5256 in-progress", description: "stale active task" });
    const [task] = await store.listTasks();

    await store.moveTask(task.id, "todo");
    await store.moveTask(task.id, "in-progress");
    // The worktree path is bogus (not registered) but the task is active. The
    // reconciler must not yank metadata out from under a running task.
    const stalePath = join(rootDir, ".worktrees", "ghost-leaf");
    mkdirSync(stalePath, { recursive: true });
    await store.updateTask(task.id, { worktree: stalePath, branch: `fusion/${task.id.toLowerCase()}` });

    const auditSpy = vi.spyOn(store, "recordRunAuditEvent");
    const manager = new SelfHealingManager(store, {
      rootDir,
      getExecutingTaskIds: () => new Set<string>(),
    });

    const repaired = await (manager as any).reconcileTaskWorktreeMetadata();
    expect(repaired).toBe(0);

    const updated = await store.getTask(task.id);
    expect(updated?.worktree).toBe(stalePath);
    expect(updated?.branch).toBe(`fusion/${task.id.toLowerCase()}`);

    expect(auditSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ mutationType: "task:auto-recover-worktree-metadata-cleared" }),
    );
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ mutationType: "task:auto-recover-worktree-metadata-skipped-active" }),
    );
  });
});
