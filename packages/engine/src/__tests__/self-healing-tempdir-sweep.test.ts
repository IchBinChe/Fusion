import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const osState = vi.hoisted(() => ({ tempRoot: "" }));
const fsState = vi.hoisted(() => ({ failRmPath: "", rmCalls: [] as string[] }));
const childState = vi.hoisted(() => ({ execCalls: [] as string[] }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, tmpdir: vi.fn(() => osState.tempRoot || actual.tmpdir()) };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    rmSync: vi.fn((path: Parameters<typeof actual.rmSync>[0], options?: Parameters<typeof actual.rmSync>[1]) => {
      const pathString = String(path);
      fsState.rmCalls.push(pathString);
      if (fsState.failRmPath && pathString === fsState.failRmPath) {
        const err = new Error("simulated tempdir rm failure") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return actual.rmSync(path, options);
    }),
  };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    exec: vi.fn((command: string, optionsOrCallback: unknown, maybeCallback?: unknown) => {
      childState.execCalls.push(command);
      const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
      queueMicrotask(() => {
        if (typeof callback === "function") callback(null, "", "");
      });
      return {} as ReturnType<typeof actual.exec>;
    }),
  };
});

import { activeSessionRegistry } from "../active-session-registry.js";
import { SelfHealingManager } from "../self-healing.js";

const RM = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as const;
let sandboxRoot = "";
let projectRoot = "";

beforeEach(() => {
  sandboxRoot = mkdtempSync(join(tmpdir(), "fusion-tempdir-sweep-sandbox-"));
  projectRoot = mkdtempSync(join(tmpdir(), "fusion-tempdir-sweep-project-"));
  osState.tempRoot = sandboxRoot;
  fsState.failRmPath = "";
  fsState.rmCalls = [];
  childState.execCalls = [];
  activeSessionRegistry.clear();
});

afterEach(() => {
  activeSessionRegistry.clear();
  osState.tempRoot = "";
  fsState.failRmPath = "";
  fsState.rmCalls = [];
  childState.execCalls = [];
  for (const dir of [sandboxRoot, projectRoot]) {
    try { rmSync(dir, RM); } catch { /* best effort */ }
  }
});

function makeStore(settings: Record<string, unknown> = {}) {
  const audits: any[] = [];
  const store: any = {
    getSettings: vi.fn(async () => ({ ...settings })),
    recordRunAuditEvent: vi.fn(async (event: any) => { audits.push(event); }),
  };
  return { store, audits };
}

function makeManager(settings: Record<string, unknown> = {}) {
  const { store, audits } = makeStore(settings);
  const manager = new SelfHealingManager(store, { rootDir: projectRoot });
  return { manager, audits };
}

function tempMergeDir(name = `fusion-ai-merge-fn-1-${Math.random().toString(36).slice(2)}`): string {
  const dir = join(sandboxRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeStale(path: string): void {
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  utimesSync(path, old, old);
}

async function sweep(manager: SelfHealingManager): Promise<number> {
  return await (manager as any).cleanupStaleTempMergeWorktrees();
}

function sweepAudits(audits: any[]) {
  return audits.filter((event) => event.mutationType === "worktree:tempdir-sweep");
}

describe("SelfHealingManager temp-dir AI merge worktree sweep", () => {
  it("removes stale fusion-ai-merge directories and emits success audits", async () => {
    const stale = tempMergeDir();
    makeStale(stale);
    const { manager, audits } = makeManager();

    await expect(sweep(manager)).resolves.toBe(1);

    expect(existsSync(stale)).toBe(false);
    expect(sweepAudits(audits)).toEqual(expect.arrayContaining([
      expect.objectContaining({ mutationType: "worktree:tempdir-sweep", metadata: expect.objectContaining({ path: realpathSync(sandboxRoot) + "/" + stale.split("/").pop(), success: true, reason: "stale" }) }),
    ]));
  });

  it("skips directories younger than the staleness threshold", async () => {
    const fresh = tempMergeDir();
    const { manager } = makeManager();

    await expect(sweep(manager)).resolves.toBe(0);

    expect(existsSync(fresh)).toBe(true);
  });

  it("skips active session paths and removes them after unregister", async () => {
    const stale = tempMergeDir();
    makeStale(stale);
    const canonical = realpathSync(stale);
    activeSessionRegistry.registerPath(canonical, { taskId: "FN-1", kind: "executor", ownerKey: "FN-1" });
    const { manager, audits } = makeManager();

    await expect(sweep(manager)).resolves.toBe(0);
    expect(existsSync(stale)).toBe(true);
    expect(sweepAudits(audits)).toEqual(expect.arrayContaining([
      expect.objectContaining({ metadata: expect.objectContaining({ path: canonical, success: false, reason: "active-session" }) }),
    ]));

    activeSessionRegistry.unregisterPath(canonical);
    await expect(sweep(manager)).resolves.toBe(1);
    expect(existsSync(stale)).toBe(false);
  });

  it("leaves non-fusion-ai-merge directories untouched", async () => {
    const other = join(sandboxRoot, "other-temp-dir");
    mkdirSync(other, { recursive: true });
    makeStale(other);
    const { manager } = makeManager();

    await expect(sweep(manager)).resolves.toBe(0);

    expect(existsSync(other)).toBe(true);
  });

  it("attempts git worktree removal before filesystem removal", async () => {
    const stale = tempMergeDir();
    makeStale(stale);
    const canonical = realpathSync(stale);
    const { manager } = makeManager();

    await expect(sweep(manager)).resolves.toBe(1);

    expect(childState.execCalls[0]).toContain(`git worktree remove --force '${canonical.replace(/'/g, `'"'"'`)}'`);
    expect(fsState.rmCalls[0]).toBe(canonical);
  });

  it("continues when one stale directory fails filesystem removal", async () => {
    const failing = tempMergeDir("fusion-ai-merge-fn-1-failing");
    const succeeding = tempMergeDir("fusion-ai-merge-fn-1-succeeding");
    makeStale(failing);
    makeStale(succeeding);
    fsState.failRmPath = realpathSync(failing);
    const { manager, audits } = makeManager();

    await expect(sweep(manager)).resolves.toBe(1);

    expect(existsSync(failing)).toBe(true);
    expect(existsSync(succeeding)).toBe(false);
    expect(sweepAudits(audits)).toEqual(expect.arrayContaining([
      expect.objectContaining({ metadata: expect.objectContaining({ path: realpathSync(failing), success: false, reason: "fs-rm-failed", error: expect.stringContaining("simulated tempdir rm failure") }) }),
      expect.objectContaining({ metadata: expect.objectContaining({ path: expect.stringContaining("succeeding"), success: true, reason: "stale" }) }),
    ]));
  });

  it("proceeds when worktrunk is enabled", async () => {
    const stale = tempMergeDir();
    makeStale(stale);
    const { manager } = makeManager({ worktrunk: { enabled: true } });

    await expect(sweep(manager)).resolves.toBe(1);

    expect(existsSync(stale)).toBe(false);
  });
});
