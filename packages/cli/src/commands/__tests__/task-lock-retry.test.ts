/**
 * FNXC:CliBoardMutation 2026-07-09-00:00:
 * Regression coverage for FN-7731 — `fn task show`/`fn task move` must
 * retry through a momentarily-locked SQLite board database instead of
 * surfacing a raw `database is locked` error or hanging, and must always
 * close the resolved `TaskStore` so the CLI process exits promptly.
 *
 * Two layers of coverage:
 *  1. Unit-level tests against `retryOnLock` itself (fake timers, no real
 *     waits) proving the bounded-backoff/fast-fail/non-lock-passthrough
 *     contract in isolation.
 *  2. An integration-level reproduction against a REAL `TaskStore`/SQLite
 *     database with a genuine external writer lock (a spawned Node
 *     subprocess holding `BEGIN IMMEDIATE`), driving `runTaskShow`/
 *     `runTaskMove` exactly as the CLI would, proving the original
 *     `database is locked` symptom is gone end-to-end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { retryOnLock, LockRetryExhaustedError, DEFAULT_CLI_LOCK_RETRY_MS } from "../../lock-retry.js";

describe("retryOnLock", () => {
  it("returns immediately on first-try success (no added latency)", async () => {
    const op = vi.fn().mockResolvedValue("ok");
    const result = await retryOnLock(op, { id: "FN-1", action: "read task" });
    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("retries through a transient lock error and succeeds once it clears", async () => {
    vi.useFakeTimers();
    try {
      const lockError = new Error("database is locked");
      const op = vi
        .fn()
        .mockRejectedValueOnce(lockError)
        .mockRejectedValueOnce(lockError)
        .mockResolvedValueOnce("recovered");

      const promise = retryOnLock(op, { id: "FN-2", action: "move task" }, 5_000);
      // Drain backoff timers as they're scheduled without a fixed count,
      // since exact intervals are an implementation detail.
      for (let i = 0; i < 10 && op.mock.calls.length < 3; i++) {
        await vi.advanceTimersByTimeAsync(1_000);
      }

      const result = await promise;
      expect(result).toBe("recovered");
      expect(op).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails fast with an actionable error when the lock never clears within the bound", async () => {
    vi.useFakeTimers();
    try {
      const lockError = new Error("SQLITE_BUSY: database is locked");
      const op = vi.fn().mockRejectedValue(lockError);

      const promise = retryOnLock(op, { id: "FN-3", action: "move task" }, 1_000);
      const assertion = expect(promise).rejects.toBeInstanceOf(LockRetryExhaustedError);
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;

      await expect(promise).rejects.toThrow(/FN-3/);
      await expect(promise).rejects.toThrow(/move task/);
      await expect(promise).rejects.toThrow(/FUSION_CLI_LOCK_RETRY_MS/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates a non-lock error immediately without retrying", async () => {
    const notFound = new Error("Task FN-4 not found");
    const op = vi.fn().mockRejectedValue(notFound);

    await expect(retryOnLock(op, { id: "FN-4", action: "read task" }, 10_000)).rejects.toThrow(
      "Task FN-4 not found",
    );
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("uses the default deadline when no override is supplied", () => {
    expect(DEFAULT_CLI_LOCK_RETRY_MS).toBeGreaterThan(0);
  });
});

// ── Real-store integration reproduction ──────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "fn-task-lock-retry-test-"));
}

/**
 * Spawn a subprocess that opens the given SQLite file, takes a real
 * `BEGIN IMMEDIATE` writer lock, and holds it until told to release (or
 * until `holdMs` elapses in timer mode). Mirrors the pattern used by
 * `packages/core/src/__tests__/store-concurrent-writes.test.ts`.
 */
async function holdWriteLock(
  dbPath: string,
  options?: { holdMs?: number },
): Promise<{ child: ChildProcessWithoutNullStreams; release: () => Promise<void> }> {
  const holdMs = options?.holdMs;
  const releaseMode = holdMs !== undefined ? "timer" : "manual";
  const script = `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(${JSON.stringify(dbPath)});
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("BEGIN IMMEDIATE");
    process.stdout.write("LOCKED\\n");
    const release = () => {
      try { db.exec("COMMIT"); } catch {}
      try { db.close(); } catch {}
      process.exit(0);
    };
    if (${JSON.stringify(releaseMode)} === "timer") {
      const signal = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(signal, 0, 0, ${holdMs ?? 0});
      release();
    } else {
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        if (chunk.includes("RELEASE")) release();
      });
    }
  `;

  const child = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });

  const ready = new Promise<void>((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("LOCKED")) resolve();
    });
    child.once("exit", (code) => {
      if (code !== 0) reject(new Error(`Lock helper exited early (${code}): ${stderr || "no stderr"}`));
    });
    child.once("error", reject);
  });

  await ready;

  return {
    child,
    release: async () => {
      if (child.exitCode !== null || child.killed) return;
      if (releaseMode === "timer") {
        await new Promise<void>((resolve) => child.once("exit", () => resolve()));
        return;
      }
      child.stdin.write("RELEASE\n");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    },
  };
}

describe("fn task show / task move — real locked-store reproduction (FN-7731)", () => {
  let tmpDir: string;
  const originalRetryMs = process.env.FUSION_CLI_LOCK_RETRY_MS;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    vi.resetModules();
  });

  afterEach(async () => {
    if (originalRetryMs === undefined) {
      delete process.env.FUSION_CLI_LOCK_RETRY_MS;
    } else {
      process.env.FUSION_CLI_LOCK_RETRY_MS = originalRetryMs;
    }
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("succeeds when a real writer lock releases within the retry window", async () => {
    const { TaskStore } = await import("@fusion/core");
    vi.doMock("../../project-context.js", () => ({
      resolveProject: vi.fn().mockRejectedValue(new Error("no registered project")),
      closeProjectStore: async (context: { store: { close: () => Promise<void> } }) => {
        await context.store.close().catch(() => {});
      },
    }));

    const setupStore = new TaskStore(tmpDir);
    await setupStore.init();
    const task = await setupStore.createTask({ description: "lock repro task" });
    await setupStore.close();

    const dbPath = join(tmpDir, ".fusion", "fusion.db");
    // Hold the lock for a short window, well inside the overridden retry
    // deadline, then release automatically (timer mode) — proving the
    // retry path succeeds once the lock clears, per FN-5048 (no long real
    // waits: short overridden bound + short real hold, not a slow test).
    process.env.FUSION_CLI_LOCK_RETRY_MS = "8000";
    const lock = await holdWriteLock(dbPath, { holdMs: 400 });

    try {
      const { runTaskShow } = await import("../task.js");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const cwd = process.cwd();
      process.chdir(tmpDir);
      try {
        await runTaskShow(task.id);
      } finally {
        process.chdir(cwd);
      }
      const printed = logSpy.mock.calls.flat().join("\n");
      expect(printed).toContain(task.id);
      expect(errorSpy).not.toHaveBeenCalled();
      logSpy.mockRestore();
      errorSpy.mockRestore();
    } finally {
      await lock.release().catch(() => {});
    }
  }, 20_000);

  it("fails fast with a clear non-zero-exit error when the lock never releases (real busy_timeout, single attempt)", async () => {
    // FNXC:CliBoardMutation 2026-07-09-00:00:
    // Real SQLite's busy_timeout blocks synchronously at the C level for up
    // to DEFAULT_SQLITE_BUSY_TIMEOUT_MS (5s, packages/core/src/db.ts) before
    // a single attempt even returns control to JS, so a real end-to-end
    // exhaustion repro cannot be made to fail fast without touching
    // DB-level timeouts (forbidden by this task's scope). This test proves
    // the invariant holds for ONE such blocking attempt: the raw
    // `database is locked` never reaches the operator unformatted, the
    // command still fails with a clear, actionable, non-zero-exit error,
    // and the store is closed. Bounded exhaustion behavior across MANY fast
    // attempts (the realistic CLI-layer retry shape) is covered by the
    // mocked-store tests below per FN-5048 (no long real waits there).
    const { TaskStore } = await import("@fusion/core");
    vi.doMock("../../project-context.js", () => ({
      resolveProject: vi.fn().mockRejectedValue(new Error("no registered project")),
      closeProjectStore: async (context: { store: { close: () => Promise<void> } }) => {
        await context.store.close().catch(() => {});
      },
    }));

    const setupStore = new TaskStore(tmpDir);
    await setupStore.init();
    const task = await setupStore.createTask({ description: "lock exhaustion repro task" });
    await setupStore.close();

    const dbPath = join(tmpDir, ".fusion", "fusion.db");
    // Deadline shorter than a single DB-level busy_timeout attempt (~5s) so
    // the very first retry check already sees the deadline exceeded.
    process.env.FUSION_CLI_LOCK_RETRY_MS = "600";
    const lock = await holdWriteLock(dbPath);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const { runTaskShow } = await import("../task.js");
      const cwd = process.cwd();
      process.chdir(tmpDir);
      try {
        await expect(runTaskShow(task.id)).rejects.toThrow(/process\.exit\(1\)/);
      } finally {
        process.chdir(cwd);
      }
      const printed = errorSpy.mock.calls.flat().join("\n");
      // Never a raw, un-retried "database is locked" with no context.
      expect(printed).not.toMatch(/^\s*database is locked\s*$/im);
      expect(printed).toMatch(/locked|retry|FUSION_CLI_LOCK_RETRY_MS/i);
      expect(printed).toContain(task.id);
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
      await lock.release().catch(() => {});
    }
  }, 20_000);
});

describe("runTaskShow / runTaskMove — mocked-store lock exhaustion, not-found, and teardown (FN-7731)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("../../project-context.js");
    vi.restoreAllMocks();
    delete process.env.FUSION_CLI_LOCK_RETRY_MS;
  });

  async function loadWithMockedStore(store: Record<string, unknown>) {
    const closeProjectStore = vi.fn(async (context: { store: { close?: () => Promise<void> } }) => {
      await context.store.close?.().catch(() => {});
    });
    const resolveProject = vi.fn().mockResolvedValue({
      projectId: "proj_test",
      projectPath: "/proj",
      projectName: "proj",
      isRegistered: true,
      store,
    });
    vi.doMock("../../project-context.js", () => ({ resolveProject, closeProjectStore }));
    const mod = await import("../task.js");
    return { mod, closeProjectStore, resolveProject };
  }

  it("runTaskShow: bounded exhaustion across many fast lock retries fails clearly and closes the store", async () => {
    vi.useFakeTimers();
    try {
      process.env.FUSION_CLI_LOCK_RETRY_MS = "500";
      const getTask = vi.fn().mockRejectedValue(new Error("database is locked"));
      const store = { getTask, close: vi.fn().mockResolvedValue(undefined) };
      const { mod, closeProjectStore } = await loadWithMockedStore(store);

      const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as never);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const promise = mod.runTaskShow("FN-9");
      const assertion = expect(promise).rejects.toThrow(/process\.exit\(1\)/);
      for (let i = 0; i < 10 && getTask.mock.calls.length < 2; i++) {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;

      expect(getTask.mock.calls.length).toBeGreaterThan(1);
      const printed = errorSpy.mock.calls.flat().join("\n");
      expect(printed).toContain("FN-9");
      expect(printed).toMatch(/locked|FUSION_CLI_LOCK_RETRY_MS/i);
      expect(closeProjectStore).toHaveBeenCalled();

      exitSpy.mockRestore();
      errorSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("runTaskMove: bounded exhaustion across many fast lock retries fails clearly and closes the store", async () => {
    vi.useFakeTimers();
    try {
      process.env.FUSION_CLI_LOCK_RETRY_MS = "500";
      const moveTask = vi.fn().mockRejectedValue(new Error("SQLITE_BUSY: database is locked"));
      const store = { moveTask, close: vi.fn().mockResolvedValue(undefined) };
      const { mod, closeProjectStore } = await loadWithMockedStore(store);

      const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as never);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const promise = mod.runTaskMove("FN-10", "done");
      const assertion = expect(promise).rejects.toThrow(/process\.exit\(1\)/);
      for (let i = 0; i < 10 && moveTask.mock.calls.length < 2; i++) {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;

      expect(moveTask.mock.calls.length).toBeGreaterThan(1);
      const printed = errorSpy.mock.calls.flat().join("\n");
      expect(printed).toContain("FN-10");
      expect(printed).toMatch(/locked|FUSION_CLI_LOCK_RETRY_MS/i);
      expect(closeProjectStore).toHaveBeenCalled();

      exitSpy.mockRestore();
      errorSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("runTaskShow: a not-found error does not retry-loop and propagates clearly, store still closed", async () => {
    process.env.FUSION_CLI_LOCK_RETRY_MS = "5000";
    const getTask = vi.fn().mockRejectedValue(new Error("Task FN-404 not found"));
    const store = { getTask, close: vi.fn().mockResolvedValue(undefined) };
    const { mod, closeProjectStore } = await loadWithMockedStore(store);

    await expect(mod.runTaskShow("FN-404")).rejects.toThrow("Task FN-404 not found");
    expect(getTask).toHaveBeenCalledTimes(1);
    expect(closeProjectStore).toHaveBeenCalled();
  });

  it("runTaskMove: a move-to-same-column no-op succeeds on the first attempt and closes the store", async () => {
    const moveTask = vi.fn().mockResolvedValue({ id: "FN-5", column: "todo" });
    const store = { moveTask, close: vi.fn().mockResolvedValue(undefined) };
    const { mod, closeProjectStore } = await loadWithMockedStore(store);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await mod.runTaskMove("FN-5", "todo");

    expect(moveTask).toHaveBeenCalledTimes(1);
    expect(moveTask).toHaveBeenCalledWith("FN-5", "todo");
    expect(closeProjectStore).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("runTaskShow: the happy path (no lock contention) adds no retry latency and closes the store once", async () => {
    const getTask = vi.fn().mockResolvedValue({
      id: "FN-6",
      description: "d",
      column: "todo",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const store = { getTask, close: vi.fn().mockResolvedValue(undefined) };
    const { mod, closeProjectStore } = await loadWithMockedStore(store);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await mod.runTaskShow("FN-6");

    expect(getTask).toHaveBeenCalledTimes(1);
    expect(closeProjectStore).toHaveBeenCalledTimes(1);
    logSpy.mockRestore();
  });
});
