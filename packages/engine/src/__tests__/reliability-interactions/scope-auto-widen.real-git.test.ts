import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { TaskStore } from "@fusion/core";

import { applyLayer3ConflictScopePartition, getConflictedFiles } from "../../merger.js";
import { checkDiffVolume, DiffVolumeRegressionError } from "../../merger-diff-volume-gate.js";

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

function git(cwd: string, cmd: string): string {
  return execSync(cmd, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function promptWithScope(scope: string[]): string {
  return `# Task\n\n## File Scope\n${scope.map((entry) => `- \`${entry}\``).join("\n")}\n\n## Steps\n- x\n`;
}

async function writeText(rootDir: string, file: string, content: string) {
  const absolute = join(rootDir, file);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content, "utf-8");
}

async function setupScenario(options: {
  taskId?: string;
  targetFile: string;
  declaredScope?: string[];
  branchCommitMessages: Array<{ subject: string; body?: string; content: string }>;
  mainContent: string;
  scopeOverride?: boolean;
  otherTaskScope?: string[];
  gitignore?: string;
  baseContent?: string;
}) {
  const taskId = options.taskId ?? "FN-5226";
  const rootDir = await mkdtemp(join(tmpdir(), "fn-5226-ri-"));
  git(rootDir, "git init -b main");
  git(rootDir, 'git config user.email "test@example.com"');
  git(rootDir, 'git config user.name "Test User"');

  await writeText(rootDir, "packages/desktop/src/foo.ts", "export const declared = 'base';\n");
  await writeText(rootDir, options.targetFile, options.baseContent ?? "base\n");
  git(rootDir, "git add .");
  git(rootDir, "git commit -m 'chore: base'");
  if (options.gitignore) {
    await writeText(rootDir, ".gitignore", `${options.gitignore}\n`);
    git(rootDir, "git add .gitignore");
    git(rootDir, "git commit -m 'chore: ignore generated artifacts'");
  }

  await mkdir(join(rootDir, ".fusion"), { recursive: true });
  const store = new TaskStore(rootDir, undefined, { inMemoryDb: true });
  await store.init();
  const createdTask = await store.createTask({
    title: "scope auto widen",
    description: taskId,
    column: "in-review",
    branch: `fusion/${taskId.toLowerCase()}`,
    baseBranch: "main",
    scopeOverride: options.scopeOverride,
    prompt: promptWithScope(options.declaredScope ?? ["packages/desktop/src/**"]),
    steps: [],
  } as any);
  const actualTaskId = createdTask.id;
  const branchName = `fusion/${actualTaskId.toLowerCase()}`;
  await store.updateTask(actualTaskId, { branch: branchName, baseBranch: "main" });
  await writeFile(join(rootDir, ".fusion", "tasks", actualTaskId, "PROMPT.md"), promptWithScope(options.declaredScope ?? ["packages/desktop/src/**"]), "utf-8");
  if (options.otherTaskScope) {
    const otherTask = await store.createTask({
      title: "other task",
      description: "other task",
      column: "todo",
      prompt: promptWithScope(options.otherTaskScope),
      steps: [],
    } as any);
    await writeFile(join(rootDir, ".fusion", "tasks", otherTask.id, "PROMPT.md"), promptWithScope(options.otherTaskScope), "utf-8");
  }

  git(rootDir, `git checkout -b ${branchName}`);
  const stageTargetFile = options.gitignore
    ? `git add -u -- ${JSON.stringify(options.targetFile)}`
    : `git add ${JSON.stringify(options.targetFile)}`;

  for (const commit of options.branchCommitMessages) {
    await writeText(rootDir, options.targetFile, commit.content);
    git(rootDir, stageTargetFile);
    const subject = commit.subject.replaceAll(taskId, actualTaskId);
    const body = commit.body?.replaceAll(taskId, actualTaskId);
    const trailer = body ? ` -m ${JSON.stringify(body)}` : "";
    git(rootDir, `git commit -m ${JSON.stringify(subject)}${trailer}`);
  }

  git(rootDir, "git checkout main");
  await writeText(rootDir, options.targetFile, options.mainContent);
  git(rootDir, stageTargetFile);
  git(rootDir, "git commit -m 'feat: main edit'");
  git(rootDir, `git merge --squash ${branchName} || true`);

  const auditEvents: Array<{ type: string; metadata: any }> = [];
  const refreshedTask = await store.getTask(actualTaskId);
  const conflicted = await getConflictedFiles(rootDir);

  return {
    rootDir,
    store,
    task: refreshedTask,
    taskId: actualTaskId,
    branchName,
    conflicted,
    auditEvents,
    partition: async () => applyLayer3ConflictScopePartition({
      store,
      task: refreshedTask,
      taskId: actualTaskId,
      rootDir,
      branch: branchName,
      mergeTargetBranch: "main",
      conflictFiles: conflicted,
      auditor: {
        git: async (event: any) => {
          auditEvents.push({ type: event.type, metadata: event.metadata });
        },
      } as any,
    }),
    cleanup: async () => {
      store.close();
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

describeIfGit("reliability interaction: scope auto-widen", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  it("clean widen keeps the file in scope, updates prompt, and emits widen audit", async () => {
    const fixture = await setupScenario({
      targetFile: "AGENTS.md",
      branchCommitMessages: [{ subject: "feat(FN-5226): touch foreign file", content: "branch\n" }],
      mainContent: "main\n",
    });
    cleanups.push(fixture.cleanup);

    const result = await fixture.partition();
    const prompt = await readFile(join(fixture.rootDir, ".fusion", "tasks", fixture.taskId, "PROMPT.md"), "utf-8");

    expect(result.inScopeConflicts).toEqual(["AGENTS.md"]);
    expect(result.skippedFiles).toEqual([]);
    expect(prompt).toContain(`scopeAutoWiden ${fixture.taskId}`);
    expect(fixture.auditEvents.some((event) => (
      event.type === "merge:scope:auto-widen" &&
      event.metadata.file === "AGENTS.md" &&
      event.metadata.attribution === "subject-prefix" &&
      Array.isArray(event.metadata.commits) &&
      event.metadata.commits.length > 0
    ))).toBe(true);
    expect(fixture.auditEvents.some((event) => event.type === "merge:layer3:foreign-file-skipped" && event.metadata.skippedFiles.includes("AGENTS.md"))).toBe(false);
  });

  it("rejects widening when a foreign-attributed commit touched the file", async () => {
    const fixture = await setupScenario({
      targetFile: "AGENTS.md",
      branchCommitMessages: [
        { subject: "feat(FN-5226): touch foreign file", content: "branch-1\n" },
        { subject: "feat(FN-7000): foreign touch", body: "Fusion-Task-Id: FN-7000", content: "branch-2\n" },
      ],
      mainContent: "main\n",
    });
    cleanups.push(fixture.cleanup);

    const result = await fixture.partition();

    expect(result.skippedFiles).toEqual(["AGENTS.md"]);
    expect(fixture.auditEvents.some((event) => event.type === "merge:scope:auto-widen")).toBe(false);
    expect(fixture.auditEvents.some((event) => event.type === "merge:layer3:foreign-file-skipped" && event.metadata.skippedFiles.includes("AGENTS.md"))).toBe(true);
  });

  it("rejects widening when another active task already claims the file", async () => {
    const fixture = await setupScenario({
      targetFile: "AGENTS.md",
      branchCommitMessages: [{ subject: "feat(FN-5226): touch foreign file", content: "branch\n" }],
      mainContent: "main\n",
      otherTaskScope: ["AGENTS.md"],
    });
    cleanups.push(fixture.cleanup);

    const result = await fixture.partition();

    expect(result.skippedFiles).toEqual(["AGENTS.md"]);
    expect(fixture.auditEvents.some((event) => event.type === "merge:scope:auto-widen")).toBe(false);
  });

  it("rejects widening for ignored-path guard files", async () => {
    const fixture = await setupScenario({
      targetFile: ".fusion/tmp.txt",
      branchCommitMessages: [{ subject: "feat(FN-5226): touch scratch file", content: "branch\n" }],
      mainContent: "main\n",
      baseContent: "base\n",
    });
    cleanups.push(fixture.cleanup);

    const result = await applyLayer3ConflictScopePartition({
      store: fixture.store,
      task: fixture.task,
      taskId: fixture.taskId,
      rootDir: fixture.rootDir,
      branch: fixture.branchName,
      mergeTargetBranch: "main",
      conflictFiles: [".fusion/tmp.txt"],
      auditor: {
        git: async (event: any) => {
          fixture.auditEvents.push({ type: event.type, metadata: event.metadata });
        },
      } as any,
    });

    expect(result.skippedFiles).toEqual([".fusion/tmp.txt"]);
    expect(fixture.auditEvents.some((event) => event.type === "merge:scope:auto-widen")).toBe(false);
    expect(fixture.auditEvents.some((event) => event.type === "merge:layer3:foreign-file-skipped")).toBe(true);
  });

  it("preserves scopeOverride short-circuit", async () => {
    const fixture = await setupScenario({
      targetFile: "AGENTS.md",
      branchCommitMessages: [{ subject: "feat(FN-5226): touch foreign file", content: "branch\n" }],
      mainContent: "main\n",
      scopeOverride: true,
    });
    cleanups.push(fixture.cleanup);

    const result = await fixture.partition();

    expect(result.viaScopeOverride).toBe(true);
    expect(fixture.auditEvents.some((event) => event.type === "merge:scope:auto-widen")).toBe(false);
    expect(fixture.auditEvents.some((event) => event.type === "merge:layer3:scope-override-bypass")).toBe(true);
  });

  it("composes with the diff-volume gate once the widened file is staged", async () => {
    const branchContent = Array.from({ length: 70 }, (_, index) => `branch-${index}`).join("\n") + "\n";
    const mainContent = Array.from({ length: 3 }, (_, index) => `main-${index}`).join("\n") + "\n";
    const fixture = await setupScenario({
      targetFile: "AGENTS.md",
      branchCommitMessages: [{ subject: "feat(FN-5226): touch foreign file", content: branchContent }],
      mainContent,
      baseContent: "base\n",
    });
    cleanups.push(fixture.cleanup);

    const result = await fixture.partition();
    expect(result.inScopeConflicts).toEqual(["AGENTS.md"]);

    await writeFile(join(fixture.rootDir, "AGENTS.md"), branchContent, "utf-8");
    git(fixture.rootDir, "git add AGENTS.md");

    await expect(checkDiffVolume({
      rootDir: fixture.rootDir,
      branch: fixture.branchName,
      integrationTargetSha: "main",
      minLines: 10,
      threshold: 0.5,
      allowlistGlobs: [],
      taskId: fixture.taskId,
    })).resolves.toBeUndefined();

    await writeFile(join(fixture.rootDir, "AGENTS.md"), mainContent, "utf-8");
    git(fixture.rootDir, "git add AGENTS.md");
    await expect(checkDiffVolume({
      rootDir: fixture.rootDir,
      branch: fixture.branchName,
      integrationTargetSha: "main",
      minLines: 10,
      threshold: 0.5,
      allowlistGlobs: [],
      taskId: fixture.taskId,
    })).rejects.toBeInstanceOf(DiffVolumeRegressionError);
  });
});
