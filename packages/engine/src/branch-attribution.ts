import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 10 * 1024 * 1024;

export interface AttributionResult {
  files: string[];
  foreignCommits: { sha: string; subject: string; attributedTaskId: string | null }[];
  ownCommitCount: number;
  rawDiffFileCount: number;
}

export class BranchAttributionError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "BranchAttributionError";
    this.cause = cause;
  }
}

export interface BranchAttributionOptions {
  worktreePath: string;
  baseRef: string;
  taskId: string;
  execAsyncImpl?: typeof execAsync;
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function extractAttributedTaskId(body: string): string | null {
  const trailerPattern = /(?:^|\n)(?:Fusion-Task-Id|Task-Id):\s*(\S+)\s*(?:\n|$)/gim;
  let match: RegExpExecArray | null = null;
  let last: RegExpExecArray | null = null;
  while (true) {
    match = trailerPattern.exec(body);
    if (!match) break;
    last = match;
  }
  return last?.[1] ?? null;
}

/**
 * FN-5083/FN-5060 hotfix: extract a task-id reference from a commit subject when the
 * `Fusion-Task-Id` trailer is missing. Recognizes conventional commits
 * (`feat(FN-123): ...`, `fix(FN-123): ...`, etc.), bracketed prefixes
 * (`[FN-123] ...`) and legacy colon prefixes (`FN-123: ...`).
 *
 * Accepts any uppercase-letter task prefix (FN, KB, RF, PROJ, JIRA, ...) so this is
 * project-agnostic. Returns the canonical `<PREFIX>-<digits>` string.
 */
function extractTaskIdFromSubject(subject: string): string | null {
  if (!subject) return null;
  // Conventional commit: feat(FN-123): ... or fix(FN-123)!: ... (case-insensitive)
  const conventional =
    /^(?:feat|fix|test|chore|docs|refactor|perf|build|ci|style|revert)\s*\(([A-Z]+-\d+)\)!?:/i.exec(subject);
  if (conventional?.[1]) return conventional[1].toUpperCase();
  // Bracketed: [FN-123] ...
  const bracketed = /^\s*\[([A-Z]+-\d+)\]/i.exec(subject);
  if (bracketed?.[1]) return bracketed[1].toUpperCase();
  // Legacy colon: FN-123: ...
  const colon = /^\s*([A-Z]+-\d+):/i.exec(subject);
  if (colon?.[1]) return colon[1].toUpperCase();
  return null;
}

function taskIdsMatch(a: string | null, b: string): boolean {
  if (!a) return false;
  return a.toUpperCase() === b.toUpperCase();
}

export async function filterFilesToOwnTaskCommits(opts: BranchAttributionOptions): Promise<AttributionResult> {
  const execImpl = opts.execAsyncImpl ?? execAsync;
  const runGit = async (command: string): Promise<string> => {
    try {
      const { stdout } = await execImpl(command, {
        cwd: opts.worktreePath,
        encoding: "utf-8",
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
      });
      return stdout;
    } catch (error) {
      const stderr =
        typeof error === "object" && error && "stderr" in error && typeof error.stderr === "string"
          ? error.stderr.trim()
          : String(error);
      throw new BranchAttributionError(`git command failed: ${command} (${stderr || "no stderr"})`, error);
    }
  };

  const rawDiffOutput = await runGit(`git diff --name-only ${quoteShellArg(opts.baseRef)}..HEAD`);
  const rawDiffFileCount = rawDiffOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean).length;

  const logOutput = await runGit(
    `git log --format=%H%x00%s%x00%B%x1e ${quoteShellArg(`${opts.baseRef}..HEAD`)}`,
  );

  if (!logOutput.trim()) {
    return { files: [], foreignCommits: [], ownCommitCount: 0, rawDiffFileCount };
  }

  const fileSet = new Set<string>();
  const foreignCommits: { sha: string; subject: string; attributedTaskId: string | null }[] = [];
  const ownCommitShas: string[] = [];

  const records = logOutput.split("\x1e").map((record) => record.trim()).filter(Boolean);
  for (const record of records) {
    const [sha = "", subject = "", ...bodyParts] = record.split("\x00");
    if (!sha) {
      throw new BranchAttributionError("malformed git log output: missing commit sha");
    }
    const body = bodyParts.join("\x00");
    const trailerAttributedTaskId = extractAttributedTaskId(body);
    // FN-5083/FN-5060 hotfix: trailer is primary; fall back to subject parsing so
    // commits without the `Fusion-Task-Id` trailer (the common case for agent-driven
    // commits today) still attribute correctly by their conventional-commit subject.
    const subjectAttributedTaskId = trailerAttributedTaskId ? null : extractTaskIdFromSubject(subject);
    const attributedTaskId = trailerAttributedTaskId ?? subjectAttributedTaskId;
    if (taskIdsMatch(attributedTaskId, opts.taskId)) {
      ownCommitShas.push(sha);
      continue;
    }
    foreignCommits.push({ sha, subject, attributedTaskId });
  }

  for (const sha of ownCommitShas) {
    const diffTreeOutput = await runGit(`git diff-tree --no-commit-id --name-only -r ${quoteShellArg(sha)}`);
    for (const file of diffTreeOutput
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)) {
      fileSet.add(file);
    }
  }

  return {
    files: [...fileSet].sort((a, b) => a.localeCompare(b)),
    foreignCommits,
    ownCommitCount: ownCommitShas.length,
    rawDiffFileCount,
  };
}
