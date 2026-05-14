import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase, ExperimentSessionStore, type Database } from "@fusion/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ExperimentExecutor,
  ExperimentGitNotConfiguredError,
  ExperimentMaxIterationsError,
} from "../experiment-executor.js";
import type { GitOps } from "../experiment/git-ops.js";

function createGitMock(): GitOps {
  return {
    head: vi.fn(),
    add: vi.fn(),
    commit: vi.fn(),
    resetHard: vi.fn(),
    stashPush: vi.fn(),
    stashPop: vi.fn(),
    statusPorcelain: vi.fn(),
    mergeBase: vi.fn(),
    branchExists: vi.fn(),
    createBranch: vi.fn(),
    cherryPick: vi.fn(),
    checkout: vi.fn(),
    currentBranch: vi.fn(),
    deleteBranch: vi.fn(),
  };
}

describe("ExperimentExecutor", () => {
  let db: Database;
  let store: ExperimentSessionStore;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "fn-exec-"));
    db = createDatabase(dir, { inMemory: true });
    db.init();
    store = new ExperimentSessionStore(db);
  });

  it("initExperiment creates session and config record", async () => {
    const executor = new ExperimentExecutor({ store, runBenchmark: vi.fn() as never });
    const { session, configRecord } = await executor.initExperiment({
      name: "exp",
      metric: { name: "accuracy", direction: "maximize" },
    });

    expect(session.status).toBe("active");
    expect(configRecord.type).toBe("config");
  });

  it("initExperiment duplicate active starts new segment", async () => {
    const executor = new ExperimentExecutor({ store, runBenchmark: vi.fn() as never });
    const first = await executor.initExperiment({ name: "dup", metric: { name: "m", direction: "maximize" }, projectId: "p" });
    const second = await executor.initExperiment({ name: "dup", metric: { name: "m", direction: "maximize" }, projectId: "p" });
    expect(second.session.id).toBe(first.session.id);
    expect(second.session.currentSegment).toBe(2);
    expect(second.configRecord.segment).toBe(2);
  });

  it("runExperiment parses metric and returns pending", async () => {
    const runBenchmark = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "METRIC accuracy=0.9", stderr: "", durationMs: 12, truncated: false, timedOut: false });
    const executor = new ExperimentExecutor({ store, runBenchmark });
    const { session } = await executor.initExperiment({ name: "run", metric: { name: "accuracy", direction: "maximize" } });
    const result = await executor.runExperiment({ sessionId: session.id, command: "x", cwd: process.cwd() });
    expect(result.status).toBe("pending");
    expect(result.primaryMetric?.value).toBe(0.9);
  });

  it("runExperiment enforces maxIterations", async () => {
    const runBenchmark = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "METRIC accuracy=0.9", stderr: "", durationMs: 12, truncated: false, timedOut: false });
    const executor = new ExperimentExecutor({ store, runBenchmark });
    const { session } = await executor.initExperiment({ name: "max", metric: { name: "accuracy", direction: "maximize" }, maxIterations: 1 });
    await executor.logExperiment({ sessionId: session.id, runResult: { runHandle: "h", exitCode: 0, stdout: "", stderr: "", durationMs: 1, primaryMetric: { name: "accuracy", value: 1 }, secondaryMetrics: [], parseWarnings: [], status: "pending" }, outcome: "errored" });
    await expect(executor.runExperiment({ sessionId: session.id, command: "x", cwd: process.cwd() })).rejects.toBeInstanceOf(ExperimentMaxIterationsError);
  });

  it("runExperiment non-zero exit is errored", async () => {
    const runBenchmark = vi.fn().mockResolvedValue({ exitCode: 1, stdout: "", stderr: "bad", durationMs: 12, truncated: false, timedOut: false });
    const executor = new ExperimentExecutor({ store, runBenchmark });
    const { session } = await executor.initExperiment({ name: "err", metric: { name: "accuracy", direction: "maximize" } });
    const result = await executor.runExperiment({ sessionId: session.id, command: "x", cwd: process.cwd() });
    expect(result.status).toBe("errored");
  });

  it("logExperiment keep commits and marks best/kept", async () => {
    const git = createGitMock();
    vi.mocked(git.commit).mockResolvedValue("sha123");
    const executor = new ExperimentExecutor({ store, git, runBenchmark: vi.fn() as never });
    const { session } = await executor.initExperiment({ name: "keep", metric: { name: "accuracy", direction: "maximize" } });
    const runResult = { runHandle: "h", exitCode: 0, stdout: "", stderr: "", durationMs: 1, primaryMetric: { name: "accuracy", value: 1 }, secondaryMetrics: [], parseWarnings: [], status: "pending" as const };
    const logged = await executor.logExperiment({ sessionId: session.id, runResult, outcome: "keep" });
    expect(logged.commit).toBe("sha123");
    expect(store.getSession(session.id)?.bestRunId).toBe(logged.runRecord.id);
    expect(store.getSession(session.id)?.keptRunIds).toContain(logged.runRecord.id);
  });

  it("logExperiment discard calls revert", async () => {
    const git = createGitMock();
    vi.mocked(git.statusPorcelain).mockResolvedValue("");
    const executor = new ExperimentExecutor({ store, git, runBenchmark: vi.fn() as never });
    const { session } = await executor.initExperiment({ name: "discard", metric: { name: "accuracy", direction: "maximize" } });
    const runResult = { runHandle: "h", exitCode: 0, stdout: "", stderr: "", durationMs: 1, primaryMetric: { name: "accuracy", value: 1 }, secondaryMetrics: [], parseWarnings: [], status: "pending" as const };
    await executor.logExperiment({ sessionId: session.id, runResult, outcome: "discard", baselineCommit: "base" });
    expect(git.resetHard).toHaveBeenCalledWith("base");
  });

  it("logExperiment keep without git throws and does not append", async () => {
    const executor = new ExperimentExecutor({ store, runBenchmark: vi.fn() as never });
    const { session } = await executor.initExperiment({ name: "nogit", metric: { name: "accuracy", direction: "maximize" } });
    const before = store.listRecords(session.id, { type: "run" }).length;
    await expect(executor.logExperiment({ sessionId: session.id, runResult: { runHandle: "h", exitCode: 0, stdout: "", stderr: "", durationMs: 1, primaryMetric: { name: "accuracy", value: 1 }, secondaryMetrics: [], parseWarnings: [], status: "pending" }, outcome: "keep" })).rejects.toBeInstanceOf(ExperimentGitNotConfiguredError);
    expect(store.listRecords(session.id, { type: "run" })).toHaveLength(before);
  });

  it("serializes runs when maxConcurrentExperiments is 1", async () => {
    const starts: number[] = [];
    const runBenchmark = vi.fn(async () => {
      starts.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { exitCode: 0, stdout: "METRIC accuracy=1", stderr: "", durationMs: 60, truncated: false, timedOut: false };
    });
    const executor = new ExperimentExecutor({ store, runBenchmark, maxConcurrentExperiments: 1 });
    const { session } = await executor.initExperiment({ name: "serial", metric: { name: "accuracy", direction: "maximize" } });
    await Promise.all([
      executor.runExperiment({ sessionId: session.id, command: "x", cwd: process.cwd() }),
      executor.runExperiment({ sessionId: session.id, command: "y", cwd: process.cwd() }),
    ]);
    expect(starts).toHaveLength(2);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(40);
  });

  it("cancel aborts in-flight run", async () => {
    let capturedSignal: AbortSignal | undefined;
    const runBenchmark = vi.fn(async (opts: { abortSignal?: AbortSignal }) => {
      capturedSignal = opts.abortSignal;
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { exitCode: capturedSignal?.aborted ? 1 : 0, stdout: "", stderr: "", durationMs: 100, truncated: false, timedOut: false };
    });
    const executor = new ExperimentExecutor({ store, runBenchmark });
    const { session } = await executor.initExperiment({ name: "cancel", metric: { name: "accuracy", direction: "maximize" } });
    const runPromise = executor.runExperiment({ sessionId: session.id, command: "x", cwd: process.cwd() });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const handle = executor.getStatus(session.id).activeHandles[0];
    expect(executor.cancel(handle)).toBe(true);
    const result = await runPromise;
    expect(result.status).toBe("errored");
  });
});
