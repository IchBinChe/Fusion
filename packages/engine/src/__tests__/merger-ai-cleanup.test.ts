import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { cleanupAiMergeWorktree, runAiMerge } from "../merger-ai.js";
import type { RunAuditor } from "../run-audit.js";

const tracked = new Set<string>();
const RM = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as const;

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tracked) {
    try { rmSync(dir, RM); } catch { /* best effort */ }
  }
  tracked.clear();
});

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, encoding: "utf-8" }).trim();
}

function makeAudit() {
  const events: any[] = [];
  const audit: RunAuditor = {
    git: vi.fn(async (event: any) => { events.push(event); }),
    database: vi.fn(async () => undefined),
    filesystem: vi.fn(async () => undefined),
    sandbox: vi.fn(async () => undefined),
  };
  return { audit, events };
}

async function cleanup(input: Partial<Parameters<typeof cleanupAiMergeWorktree>[0]> = {}) {
  const mergeRoot = input.mergeRoot ?? mkdtempSync(join(tmpdir(), "fusion-ai-merge-fn-1-cleanup-test-"));
  tracked.add(mergeRoot);
  const { audit, events } = makeAudit();
  const logs: string[] = [];
  await cleanupAiMergeWorktree({
    taskId: "FN-1",
    mergeRoot,
    projectRootDir: input.projectRootDir ?? process.cwd(),
    worktreeAdded: input.worktreeAdded ?? true,
    audit: input.audit ?? audit,
    log: input.log ?? vi.fn(async (message: string) => { logs.push(message); }),
    gitRunner: input.gitRunner ?? vi.fn(async () => ""),
    rmRunner: input.rmRunner ?? rm,
  });
  return { mergeRoot, events, logs };
}

function initRepoWithBranch(): { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "fusion-ai-merge-cleanup-test-"));
  tracked.add(dir);
  git(dir, "init -q -b main");
  git(dir, "config user.email t@t.t");
  git(dir, "config user.name t");
  writeFileSync(join(dir, "base.txt"), "base\n");
  git(dir, "add -A");
  git(dir, "commit -q -m base");
  git(dir, "checkout -q -b fusion/fn-1");
  writeFileSync(join(dir, "feature.txt"), "feature work\n");
  git(dir, "add -A");
  git(dir, "commit -q -m 'feat: work'");
  git(dir, "checkout -q main");
  return { dir };
}

function makeStore() {
  const task: any = {
    id: "FN-1",
    column: "in-review",
    status: null,
    branch: "fusion/fn-1",
    worktree: null,
    title: "do the thing",
    steps: [],
  };
  const audits: any[] = [];
  const logs: string[] = [];
  const store: any = {
    getTask: vi.fn(async () => task),
    getSettings: vi.fn(async () => ({ merger: { mode: "ai", maxReviewPasses: 1 } })),
    updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => { Object.assign(task, patch); return task; }),
    moveTask: vi.fn(async (_id: string, column: string) => { task.column = column; return task; }),
    emit: vi.fn(),
    logEntry: vi.fn(async (_id: string, message: string) => { logs.push(message); }),
    appendAgentLog: vi.fn(async (_id: string, message: string) => { logs.push(message); }),
    recordRunAuditEvent: vi.fn(async (event: any) => { audits.push(event); }),
  };
  return { store, audits, logs };
}

function realMergeAgent() {
  return vi.fn(async (cwd: string) => {
    execSync("git merge --squash fusion/fn-1", { cwd, stdio: "pipe" });
    execSync("git add -A", { cwd, stdio: "pipe" });
    execSync('git commit -q -m "squash: feature"', { cwd, stdio: "pipe" });
  });
}

describe("AI merge temp worktree cleanup", () => {
  it("emits audit event and logs stderr on git worktree removal failure", async () => {
    const err = new Error("git remove failed") as Error & { stderr?: string; code?: string };
    err.stderr = "fatal: simulated worktree remove failure";
    err.code = "1";

    const { mergeRoot, events, logs } = await cleanup({ gitRunner: vi.fn(async () => { throw err; }) });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "merge:ai-worktree-cleanup", metadata: expect.objectContaining({ phase: "git-remove", success: false, error: expect.stringContaining("simulated worktree remove failure"), code: "1" }) }),
      expect.objectContaining({ type: "merge:ai-worktree-cleanup", metadata: expect.objectContaining({ phase: "fs-rm", success: true }) }),
    ]));
    expect(logs.join("\n")).toContain("simulated worktree remove failure");
    expect(existsSync(mergeRoot)).toBe(false);
  });

  it("emits audit event and logs errno details on filesystem rm failure", async () => {
    const err = new Error("simulated filesystem cleanup denial") as NodeJS.ErrnoException;
    err.code = "EACCES";

    const { events, logs } = await cleanup({ rmRunner: vi.fn(async () => { throw err; }) as typeof rm });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "merge:ai-worktree-cleanup", metadata: expect.objectContaining({ phase: "git-remove", success: true }) }),
      expect.objectContaining({ type: "merge:ai-worktree-cleanup", metadata: expect.objectContaining({ phase: "fs-rm", success: false, code: "EACCES", error: expect.stringContaining("simulated filesystem cleanup denial") }) }),
    ]));
    expect(logs.join("\n")).toContain("EACCES");
  });

  it("emits success audit events on happy-path cleanup", async () => {
    const { events } = await cleanup();

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "merge:ai-worktree-cleanup", metadata: expect.objectContaining({ phase: "git-remove", success: true }) }),
      expect.objectContaining({ type: "merge:ai-worktree-cleanup", metadata: expect.objectContaining({ phase: "fs-rm", success: true }) }),
    ]));
  });

  it("skips git removal but still audits filesystem cleanup when worktree was not added", async () => {
    const gitRunner = vi.fn(async () => "");

    const { events } = await cleanup({ worktreeAdded: false, gitRunner });

    expect(gitRunner).not.toHaveBeenCalled();
    expect(events.some((event) => event.metadata.phase === "git-remove")).toBe(false);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "merge:ai-worktree-cleanup", metadata: expect.objectContaining({ phase: "fs-rm", success: true }) }),
    ]));
  });

  it("runAiMerge emits success cleanup audit events", async () => {
    const { dir } = initRepoWithBranch();
    const { store, audits } = makeStore();

    await runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: realMergeAgent(),
      reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
    });

    const cleanupEvents = audits.filter((event) => event.mutationType === "merge:ai-worktree-cleanup");
    expect(cleanupEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ metadata: expect.objectContaining({ phase: "git-remove", success: true }) }),
      expect.objectContaining({ metadata: expect.objectContaining({ phase: "fs-rm", success: true }) }),
    ]));
  });
});
