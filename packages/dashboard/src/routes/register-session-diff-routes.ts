import { access } from "node:fs/promises";
import { join } from "node:path";
import type { Request, Router } from "express";
import type { RunAuditEvent, RunAuditEventFilter } from "@fusion/core";
import { isWorkspaceTask } from "@fusion/core";
import { ApiError, notFound, rethrowAsApiError } from "../api-error.js";
import { resolveDiffBase, runGitCommand } from "./resolve-diff-base.js";
import { countPatchLines } from "./diff-counts.js";
import { filterFilesToOwnTaskCommits } from "./attribute-done-range-files.js";
import type { ProjectContext } from "./types.js";

export interface SessionDiffRouteDeps {
  getProjectContext: (req: Request) => Promise<ProjectContext>;
}

/**
 * Confirm the worktree's current branch still matches the task's recorded
 * branch. Worktrees from the recycle pool can be reassigned to a different
 * task after a merge; without this check the diff endpoints would happily
 * read another task's branch state and surface its commits as the original
 * task's "files changed" list. Returns true when no validation is possible
 * (e.g. task.branch was never set) so we don't break tests/legacy tasks.
 */
async function worktreeStillBelongsToTask(
  worktree: string,
  expectedBranch: string | undefined | null,
): Promise<boolean> {
  if (!expectedBranch) return true;
  try {
    const actual = (await runGitCommand(["rev-parse", "--abbrev-ref", "HEAD"], worktree, 5000)).trim();
    if (!actual || actual === "HEAD") return true; // detached HEAD — can't validate
    return actual === expectedBranch;
  } catch {
    return true; // best-effort: never block diff just because rev-parse failed
  }
}

const sessionFilesCache = new Map<string, { files: string[]; expiresAt: number }>();
const fileDiffsCache = new Map<
  string,
  {
    files: Array<{ path: string; status: "added" | "modified" | "deleted" | "renamed"; diff: string; oldPath?: string }>;
    expiresAt: number;
  }
>();

type DoneTaskFileStatus = "added" | "modified" | "deleted" | "renamed";

const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

type BranchFallbackTask = {
  branch?: string | null;
  baseBranch?: string;
  baseCommitSha?: string;
};

async function resolveTaskBranchRef(task: BranchFallbackTask, rootDir: string, derivedBranchHint?: string): Promise<string | undefined> {
  const branch = task.branch?.trim() || derivedBranchHint?.trim();
  if (!branch) return undefined;

  try {
    const resolved = (await runGitCommand(["rev-parse", "--verify", "--quiet", branch], rootDir, 5000)).trim();
    if (resolved) return branch;
  } catch {
    // continue to refs/heads fallback
  }

  const headsRef = `refs/heads/${branch}`;
  try {
    const resolved = (await runGitCommand(["rev-parse", "--verify", "--quiet", headsRef], rootDir, 5000)).trim();
    if (resolved) return headsRef;
  } catch {
    // unresolved
  }

  return undefined;
}

async function resolveBranchDiffBaseInRoot(task: BranchFallbackTask, rootDir: string, derivedBranchHint?: string): Promise<{ baseRef: string; branchRef: string } | undefined> {
  const branchRef = await resolveTaskBranchRef(task, rootDir, derivedBranchHint);
  if (!branchRef) return undefined;

  const baseRef = await resolveDiffBase(task, rootDir, branchRef, runGitCommand, { enableDisplayRecovery: true });
  if (!baseRef) return undefined;

  return { baseRef, branchRef };
}

async function tryBranchRefFallbackFiles(
  task: BranchFallbackTask & { id: string },
  rootDir: string,
  derivedBranchHint?: string,
): Promise<string[]> {
  const resolved = await resolveBranchDiffBaseInRoot(task, rootDir, derivedBranchHint);
  if (!resolved) return [];

  try {
    const changed = (await runGitCommand(["diff", "--name-only", `${resolved.baseRef}..${resolved.branchRef}`], rootDir, 5000)).trim();
    return changed.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function tryBranchRefFallbackDetailedDiff(
  task: BranchFallbackTask,
  rootDir: string,
  derivedBranchHint?: string,
): Promise<{
  files: Array<{ path: string; status: "added" | "modified" | "deleted"; additions: number; deletions: number; patch: string }>;
  stats: { filesChanged: number; additions: number; deletions: number };
}> {
  const resolved = await resolveBranchDiffBaseInRoot(task, rootDir, derivedBranchHint);
  if (!resolved) {
    return { files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 } };
  }

  const fileMap = new Map<string, string>();
  try {
    const nameStatusOutput = (await runGitCommand(["diff", "--name-status", "-M", `${resolved.baseRef}..${resolved.branchRef}`], rootDir, 10000)).trim();
    for (const line of nameStatusOutput.split("\n").filter(Boolean)) {
      const parsed = parseNameStatusLine(line);
      if (!parsed) continue;
      fileMap.set(parsed.path, parsed.statusCode);
    }
  } catch {
    return { files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 } };
  }

  const files: Array<{ path: string; status: "added" | "modified" | "deleted"; additions: number; deletions: number; patch: string }> = [];
  for (const [filePath, statusCode] of fileMap.entries()) {
    let status: "added" | "modified" | "deleted" = "modified";
    if (statusCode.startsWith("A")) status = "added";
    else if (statusCode.startsWith("D")) status = "deleted";

    let patch = "";
    try {
      patch = await runGitCommand(["diff", `${resolved.baseRef}..${resolved.branchRef}`, "--", filePath], rootDir, 10000);
    } catch {
      patch = "";
    }

    const { additions, deletions } = countPatchLines(patch);
    files.push({ path: filePath, status, additions, deletions, patch });
  }

  return {
    files,
    stats: {
      filesChanged: files.length,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    },
  };
}

async function tryBranchRefFallbackFileDiffs(
  task: BranchFallbackTask,
  rootDir: string,
  derivedBranchHint?: string,
): Promise<Array<{ path: string; status: "added" | "modified" | "deleted" | "renamed"; diff: string; oldPath?: string }>> {
  const resolved = await resolveBranchDiffBaseInRoot(task, rootDir, derivedBranchHint);
  if (!resolved) return [];

  const fileMap = new Map<string, { statusCode: string; oldPath?: string }>();
  try {
    const nameStatusOutput = (await runGitCommand(["diff", "--name-status", "-M", `${resolved.baseRef}..${resolved.branchRef}`], rootDir, 5000)).trim();
    for (const line of nameStatusOutput.split("\n").filter(Boolean)) {
      const parsed = parseNameStatusLine(line);
      if (!parsed) continue;
      fileMap.set(parsed.path, { statusCode: parsed.statusCode, oldPath: parsed.oldPath });
    }
  } catch {
    return [];
  }

  const files: Array<{ path: string; status: "added" | "modified" | "deleted" | "renamed"; diff: string; oldPath?: string }> = [];
  for (const [filePath, { statusCode, oldPath }] of fileMap.entries()) {
    let status: "added" | "modified" | "deleted" | "renamed" = "modified";
    if (statusCode.startsWith("A")) status = "added";
    else if (statusCode.startsWith("D")) status = "deleted";
    else if (statusCode.startsWith("R")) status = "renamed";

    let diff = "";
    try {
      diff = await runGitCommand(["diff", `${resolved.baseRef}..${resolved.branchRef}`, "--", filePath], rootDir, 5000);
    } catch {
      diff = "";
    }

    if (!diff) continue;
    files.push(oldPath ? { path: filePath, status, diff, oldPath } : { path: filePath, status, diff });
  }

  return files;
}

type AggregatedDoneTaskFile = {
  path: string;
  status: DoneTaskFileStatus;
  additions: number;
  deletions: number;
  patch: string;
};

function parseGitShortstat(output: string): { filesChanged: number; additions: number; deletions: number } {
  const filesMatch = output.match(/(\d+) files? changed/);
  const additionsMatch = output.match(/(\d+) insertions?\(\+\)/);
  const deletionsMatch = output.match(/(\d+) deletions?\(-\)/);
  return {
    filesChanged: filesMatch ? Number(filesMatch[1]) : 0,
    additions: additionsMatch ? Number(additionsMatch[1]) : 0,
    deletions: deletionsMatch ? Number(deletionsMatch[1]) : 0,
  };
}

function statusPriority(status: DoneTaskFileStatus): number {
  switch (status) {
    case "added":
      return 4;
    case "modified":
      return 3;
    case "renamed":
      return 2;
    case "deleted":
      return 1;
    default:
      return 0;
  }
}

async function isReachableFromHead(sha: string, rootDir: string): Promise<boolean> {
  try {
    await runGitCommand(["merge-base", "--is-ancestor", sha, "HEAD"], rootDir, 5000);
    return true;
  } catch {
    return false;
  }
}

type DoneTaskAggregationTask = {
  id: string;
  lineageId?: string | null;
  mergeDetails?: {
    commitSha?: string;
    rebaseBaseSha?: string;
    filesChanged?: number;
    insertions?: number;
    deletions?: number;
    landedFiles?: string[];
    landedFilesAttributionRestricted?: boolean;
    noOpVerifiedShortCircuit?: boolean;
  } | null;
};

type DoneTaskAggregationStore = {
  getRootDir: () => string;
  getTaskCommitAssociationsByLineageId: (lineageId: string) => Promise<Array<{ commitSha: string; authoredAt?: string | null }>>;
  getRunAuditEvents?: (options?: RunAuditEventFilter) => RunAuditEvent[] | Promise<RunAuditEvent[]>;
};

async function resolveCommitDiffSpec(sha: string, rootDir: string): Promise<
  | { mode: "root"; base: string; range: string }
  | { mode: "single-parent"; base: string; range: string }
  | { mode: "merge"; range: string }
> {
  const parentLine = (await runGitCommand(["rev-list", "--parents", "-n", "1", sha], rootDir, 5000)).trim();
  const parts = parentLine.split(/\s+/).filter(Boolean);
  if (parts.length <= 1) {
    return { mode: "root", base: EMPTY_TREE_SHA, range: `${EMPTY_TREE_SHA}..${sha}` };
  }

  const parents = parts.slice(1);
  if (parents.length >= 2) {
    return { mode: "merge", range: `${sha}^1...${sha}^2` };
  }

  return { mode: "single-parent", base: parents[0]!, range: `${parents[0]}..${sha}` };
}

async function resolveRebaseDiffSpec(
  rebaseBaseSha: string,
  commitSha: string,
  rootDir: string,
): Promise<{ mode: "rebase-range"; base: string; range: string } | null> {
  try {
    await runGitCommand(["merge-base", "--is-ancestor", rebaseBaseSha, commitSha], rootDir, 5000);
    return { mode: "rebase-range", base: rebaseBaseSha, range: `${rebaseBaseSha}..${commitSha}` };
  } catch {
    return null;
  }
}

function parseStatusCode(statusCode: string): DoneTaskFileStatus {
  if (statusCode.startsWith("A")) return "added";
  if (statusCode.startsWith("D")) return "deleted";
  if (statusCode.startsWith("R")) return "renamed";
  return "modified";
}

/**
 * Parse a single `git diff --name-status` line.
 *
 * Rename/copy entries are detected by `R*`/`C*` status prefixes. Their
 * destination path is `parts[2]` in normal output, with a defensive `parts[3]`
 * fallback for variants that split score fields across extra tab columns.
 */
function parseNameStatusLine(line: string): { statusCode: string; path: string; oldPath?: string } | null {
  const parts = line.split("\t");
  const statusCode = parts[0] ?? "M";
  const isRenameLike = statusCode.startsWith("R") || statusCode.startsWith("C");
  const oldPath = isRenameLike ? (parts[1] ?? "") : undefined;
  const path = isRenameLike ? (parts.length > 3 ? (parts[3] ?? "") : (parts[2] ?? "")) : (parts[1] ?? "");
  if (!path) return null;
  return oldPath ? { statusCode, path, oldPath } : { statusCode, path };
}

async function restrictActiveCommittedFilesToOwnTask<T>(
  fileMap: Map<string, T>,
  input: {
    taskId: string;
    diffBase?: string;
    worktreePath: string;
    runGit: (args: string[]) => Promise<string>;
  },
): Promise<void> {
  if (!input.diffBase || fileMap.size === 0) return;

  try {
    const attribution = await filterFilesToOwnTaskCommits({
      worktreePath: input.worktreePath,
      baseRef: input.diffBase,
      taskId: input.taskId,
      runGit: input.runGit,
    });

    if (attribution.foreignCommitCount === 0 || attribution.ownCommitShas.length === 0 || attribution.files.length === 0) {
      return;
    }

    const ownFiles = new Set(attribution.files);
    for (const filePath of fileMap.keys()) {
      if (!ownFiles.has(filePath)) {
        fileMap.delete(filePath);
      }
    }
  } catch {
    // Display-only attribution. If git metadata is unavailable, preserve the
    // existing broad diff rather than hiding task files.
  }
}

async function collectDoneRangeFiles(range: string, rootDir: string): Promise<AggregatedDoneTaskFile[]> {
  const nameStatus = (await runGitCommand(["diff", "--name-status", "-M", range], rootDir, 10000)).trim();
  const files: AggregatedDoneTaskFile[] = [];

  for (const line of nameStatus.split("\n").filter(Boolean)) {
    const parsed = parseNameStatusLine(line);
    if (!parsed) continue;
    const { statusCode, path: filePath, oldPath } = parsed;

    let patch = "";
    try {
      patch = await runGitCommand(["diff", "-M", range, "--", filePath], rootDir, 10000);
    } catch {
      patch = "";
    }

    const { additions, deletions } = countPatchLines(patch);
    const status = parseStatusCode(statusCode);
    files.push(oldPath ? { path: filePath, status, additions, deletions, patch: patch || `rename from ${oldPath}\nrename to ${filePath}\n` } : { path: filePath, status, additions, deletions, patch });
  }

  return files;
}

interface WorktreeDetailedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  patch: string;
  oldPath?: string;
}

/**
 * Build the per-file detailed diff for a SINGLE worktree: committed
 * (diffBase..HEAD) + staged + unstaged, with the committed set scoped to the
 * task's own commits. Untracked files are intentionally excluded — at review
 * time they are almost always build artifacts/cache/logs.
 *
 * Extracted so the single-repo diff endpoints AND the per-sub-repo workspace
 * aggregation (computeWorkspaceTaskFiles) share ONE implementation. The
 * single-repo `/tasks/:id/diff` and `/tasks/:id/file-diffs` paths must remain
 * behaviour-identical to their previous inline form.
 */
async function computeWorktreeDetailedFiles(
  taskLike: { id: string; baseBranch?: string; baseCommitSha?: string },
  cwd: string,
  timeoutMs: number,
): Promise<WorktreeDetailedFile[]> {
  const diffBase = await resolveDiffBase(taskLike, cwd, "HEAD", undefined, { enableDisplayRecovery: true });

  const fileMap = new Map<string, { statusCode: string; oldPath?: string }>();

  if (diffBase) {
    try {
      const committedOutput = (await runGitCommand(["diff", "--name-status", "-M", `${diffBase}..HEAD`], cwd, timeoutMs)).trim();
      for (const line of committedOutput.split("\n").filter(Boolean)) {
        const parsed = parseNameStatusLine(line);
        if (!parsed) continue;
        fileMap.set(parsed.path, { statusCode: parsed.statusCode, oldPath: parsed.oldPath });
      }
    } catch {
      // committed diff failed
    }
  }

  await restrictActiveCommittedFilesToOwnTask(fileMap, {
    taskId: taskLike.id,
    diffBase,
    worktreePath: cwd,
    runGit: (args) => runGitCommand(args, cwd, timeoutMs),
  });

  try {
    const stagedOutput = (await runGitCommand(["diff", "--cached", "--name-status", "-M"], cwd, timeoutMs)).trim();
    for (const line of stagedOutput.split("\n").filter(Boolean)) {
      const parsed = parseNameStatusLine(line);
      if (!parsed || fileMap.has(parsed.path)) continue;
      fileMap.set(parsed.path, { statusCode: parsed.statusCode, oldPath: parsed.oldPath });
    }
  } catch {
    // staged diff failed
  }

  try {
    const workingTreeOutput = (await runGitCommand(["diff", "--name-status", "-M"], cwd, timeoutMs)).trim();
    for (const line of workingTreeOutput.split("\n").filter(Boolean)) {
      const parsed = parseNameStatusLine(line);
      if (!parsed || fileMap.has(parsed.path)) continue;
      fileMap.set(parsed.path, { statusCode: parsed.statusCode, oldPath: parsed.oldPath });
    }
  } catch {
    // working tree diff failed
  }

  const results: WorktreeDetailedFile[] = [];
  for (const [filePath, { statusCode, oldPath }] of fileMap.entries()) {
    if (!filePath) continue;

    let status: "added" | "modified" | "deleted" | "renamed" = "modified";
    if (statusCode.startsWith("A")) status = "added";
    else if (statusCode.startsWith("D")) status = "deleted";
    else if (statusCode.startsWith("R")) status = "renamed";

    let patch = "";
    try {
      patch = diffBase
        ? await runGitCommand(["diff", diffBase, "--", filePath], cwd, timeoutMs)
        : await runGitCommand(["diff", "HEAD", "--", filePath], cwd, timeoutMs);
    } catch {
      // ignore individual file errors
    }

    const { additions, deletions } = countPatchLines(patch);
    results.push(oldPath ? { path: filePath, status, additions, deletions, patch, oldPath } : { path: filePath, status, additions, deletions, patch });
  }

  return results;
}

/**
 * Aggregate a workspace task's changed files across ALL acquired sub-repo
 * worktrees. A workspace task has no singular `task.worktree`/`task.branch`
 * (those are null by design); its per-repo state lives in
 * `task.workspaceWorktrees`. Each sub-repo's diff is computed in its own live
 * worktree (in-progress/in-review) or, when that worktree is gone (done tasks),
 * from its landed range in the sub-repo root. Every file path is prefixed with
 * the sub-repo key (e.g. `openvide/src/foo.ts`) so the Changes tab shows which
 * sub-repo each file belongs to. A missing/unreadable sub-repo is skipped
 * best-effort rather than failing the whole response.
 */
async function computeWorkspaceTaskFiles(
  task: {
    id: string;
    baseBranch?: string;
    workspaceWorktrees?: Record<string, { worktreePath: string; branch: string; baseCommitSha?: string; landedSha?: string }>;
  },
  rootDir: string,
  timeoutMs: number,
): Promise<WorktreeDetailedFile[]> {
  const worktrees = task.workspaceWorktrees ?? {};
  const all: WorktreeDetailedFile[] = [];

  // Deterministic, repo-sorted order so the aggregated list is stable.
  for (const repoRel of Object.keys(worktrees).sort()) {
    const entry = worktrees[repoRel];
    if (!entry) continue;

    let repoFiles: WorktreeDetailedFile[] = [];

    // Prefer the live sub-repo worktree (in-progress / in-review).
    let worktreeUsable = false;
    if (entry.worktreePath) {
      try {
        await access(entry.worktreePath);
        worktreeUsable = true;
      } catch {
        worktreeUsable = false;
      }
    }
    if (worktreeUsable) {
      try {
        repoFiles = await computeWorktreeDetailedFiles(
          // Per-repo base: use the sub-repo's own captured fork point, with the
          // workspace task's baseBranch stripped so resolveDiffBase uses the
          // per-repo baseCommitSha rather than a shared workspace branch.
          { id: task.id, baseBranch: undefined, baseCommitSha: entry.baseCommitSha },
          entry.worktreePath,
          timeoutMs,
        );
      } catch {
        repoFiles = [];
      }
    }

    // Fallback: landed range in the sub-repo root (a done task whose per-repo
    // worktree was already cleaned up). Each sub-repo lands independently with
    // its own baseCommitSha → landedSha.
    if (repoFiles.length === 0 && entry.baseCommitSha && entry.landedSha) {
      const repoRootDir = join(rootDir, repoRel);
      try {
        const rangeFiles = await collectDoneRangeFiles(`${entry.baseCommitSha}..${entry.landedSha}`, repoRootDir);
        repoFiles = rangeFiles.map((file) => ({
          path: file.path,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          patch: file.patch,
        }));
      } catch {
        repoFiles = [];
      }
    }

    for (const file of repoFiles) {
      all.push({
        ...file,
        path: `${repoRel}/${file.path}`,
        oldPath: file.oldPath ? `${repoRel}/${file.oldPath}` : undefined,
      });
    }
  }

  return all;
}

function extractCommitShaCandidate(event: { target?: unknown; metadata?: unknown; payload?: unknown; newValue?: unknown }): string | undefined {
  if (typeof event.target === "string" && event.target.trim()) {
    return event.target.trim();
  }

  const candidateObjects = [event.metadata, event.payload, event.newValue].filter((value): value is Record<string, unknown> => !!value && typeof value === "object");
  for (const candidate of candidateObjects) {
    const commitSha = candidate.commitSha;
    if (typeof commitSha === "string" && commitSha.trim()) {
      return commitSha.trim();
    }
  }

  return undefined;
}

async function resolveAuditCommitSha(taskId: string, scopedStore: DoneTaskAggregationStore): Promise<string | undefined> {
  if (!scopedStore.getRunAuditEvents) return undefined;

  const rootDir = scopedStore.getRootDir();
  const mutationTypes = ["git:commit", "commit:create", "commit:amend"];
  for (const mutationType of mutationTypes) {
    const eventsRaw = await Promise.resolve(scopedStore.getRunAuditEvents({ taskId, domain: "git", mutationType: mutationType as RunAuditEventFilter["mutationType"], limit: 5 }));
    const events = Array.isArray(eventsRaw) ? eventsRaw : [];
    for (const event of events as Array<{ target?: unknown; metadata?: unknown; payload?: unknown; newValue?: unknown }>) {
      const candidate = extractCommitShaCandidate(event);
      if (!candidate) continue;
      try {
        const resolved = (await runGitCommand(["rev-parse", "--verify", "--quiet", candidate], rootDir, 5000)).trim();
        if (resolved && (await isReachableFromHead(resolved, rootDir))) {
          return resolved;
        }
      } catch {
        // ignore invalid or unreachable candidates
      }
    }
  }

  return undefined;
}

export async function isAtOrBelowTaskBase(sha: string, baseCommitSha: string, rootDir: string): Promise<boolean> {
  if (sha === baseCommitSha) return true;
  try {
    await runGitCommand(["merge-base", "--is-ancestor", sha, baseCommitSha], rootDir, 5000);
    return true;
  } catch {
    return false;
  }
}

async function resolveDoneTaskMergeSha(
  task: DoneTaskAggregationTask & { baseCommitSha?: string | null },
  scopedStore: DoneTaskAggregationStore,
  options?: { includeBaseCommitSha?: boolean },
): Promise<string | undefined> {
  const rootDir = scopedStore.getRootDir();
  const baseCommitSha = task.baseCommitSha?.trim();
  const includeBaseCommitSha = options?.includeBaseCommitSha === true;

  const existing = task.mergeDetails?.commitSha?.trim();
  if (existing) {
    if (!includeBaseCommitSha && baseCommitSha && existing === baseCommitSha) return undefined;
    return existing;
  }

  const auditSha = await resolveAuditCommitSha(task.id, scopedStore);
  if (auditSha) {
    if (!includeBaseCommitSha && baseCommitSha && auditSha === baseCommitSha) return undefined;
    return auditSha;
  }

  if (!task.lineageId) return undefined;
  const associations = await scopedStore.getTaskCommitAssociationsByLineageId(task.lineageId);
  for (const association of associations) {
    if (!association.commitSha) continue;
    if (!includeBaseCommitSha && baseCommitSha && association.commitSha === baseCommitSha) continue;
    if (await isReachableFromHead(association.commitSha, rootDir)) {
      return association.commitSha;
    }
  }

  return undefined;
}

async function collectDoneTaskFiles(task: DoneTaskAggregationTask, scopedStore: DoneTaskAggregationStore): Promise<{
  files: AggregatedDoneTaskFile[];
  stats: { filesChanged: number; additions: number; deletions: number };
  usedAggregation: boolean;
}> {
  const rootDir = scopedStore.getRootDir();
  const mergeSha = task.mergeDetails?.commitSha;
  const orderedShas: string[] = [];

  if (task.lineageId) {
    const associations = await scopedStore.getTaskCommitAssociationsByLineageId(task.lineageId);
    const sorted = [...associations].sort((a, b) => {
      const left = a.authoredAt ? Date.parse(a.authoredAt) : Number.POSITIVE_INFINITY;
      const right = b.authoredAt ? Date.parse(b.authoredAt) : Number.POSITIVE_INFINITY;
      return left - right;
    });
    for (const association of sorted) {
      if (association.commitSha && !orderedShas.includes(association.commitSha)) {
        orderedShas.push(association.commitSha);
      }
    }
  }

  if (mergeSha && !orderedShas.includes(mergeSha)) {
    orderedShas.push(mergeSha);
  }

  const reachableShas: string[] = [];
  for (const sha of orderedShas) {
    if (await isReachableFromHead(sha, rootDir)) {
      reachableShas.push(sha);
    }
  }

  if (reachableShas.length === 0) {
    return {
      files: [],
      stats: {
        filesChanged: 0,
        additions: 0,
        deletions: 0,
      },
      usedAggregation: false,
    };
  }

  const byPath = new Map<string, AggregatedDoneTaskFile>();
  let usedAggregation = false;

  for (const sha of reachableShas) {
    let diffSpec: Awaited<ReturnType<typeof resolveCommitDiffSpec>>;
    try {
      diffSpec = await resolveCommitDiffSpec(sha, rootDir);
    } catch {
      continue;
    }

    let filesForSha: AggregatedDoneTaskFile[] = [];
    try {
      filesForSha = await collectDoneRangeFiles(diffSpec.range, rootDir);
    } catch {
      continue;
    }

    if (filesForSha.length > 0) {
      usedAggregation = true;
    }

    for (const file of filesForSha) {
      const existing = byPath.get(file.path);
      if (!existing) {
        byPath.set(file.path, { ...file });
        continue;
      }

      const representative = (file.additions + file.deletions) > (existing.additions + existing.deletions) ? file.patch : existing.patch;
      const status = statusPriority(file.status) > statusPriority(existing.status) ? file.status : existing.status;

      byPath.set(file.path, {
        path: file.path,
        status,
        additions: existing.additions + file.additions,
        deletions: existing.deletions + file.deletions,
        patch: representative,
      });
    }
  }

  const files = Array.from(byPath.values());

  return {
    files,
    stats: {
      filesChanged: files.length,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    },
    usedAggregation,
  };
}

async function restrictRebaseRangeFiles(
  task: DoneTaskAggregationTask,
  rebaseRangeFiles: AggregatedDoneTaskFile[],
  deps: {
    rootDir: string;
    rebaseBaseShaForAggregation: string;
    runGit: (args: string[]) => Promise<string>;
  },
): Promise<AggregatedDoneTaskFile[]> {
  const landed = task.mergeDetails?.landedFiles;
  const restricted =
    task.mergeDetails?.landedFilesAttributionRestricted === true ||
    task.mergeDetails?.noOpVerifiedShortCircuit === true;
  const landedSet = new Set(landed ?? []);

  if (restricted) {
    // FN-5154 + FN-5103: restricted landedFiles are authoritative; empty landed
    // (including no-op short-circuit) must never widen to rebase-range files.
    return rebaseRangeFiles.filter((file) => landedSet.has(file.path));
  }

  if (Array.isArray(landed) && landed.length > 0) {
    return rebaseRangeFiles.filter((file) => landedSet.has(file.path));
  }

  try {
    const attribution = await filterFilesToOwnTaskCommits({
      worktreePath: deps.rootDir,
      baseRef: deps.rebaseBaseShaForAggregation,
      taskId: task.id,
      runGit: deps.runGit,
    });
    if (attribution.files.length === 0) {
      // Read-only done-task diff display should still surface the rebase range
      // when commit attribution cannot prove ownership from subjects/trailers.
      return rebaseRangeFiles;
    }
    const ownSet = new Set(attribution.files);
    return rebaseRangeFiles.filter((file) => ownSet.has(file.path));
  } catch (err) {
    console.warn(
      `[diff] FN-5154 attribution failed for ${task.id}: ${(err as Error).message}; falling back to unrestricted range`,
    );
    return rebaseRangeFiles;
  }
}

/**
 * Registers task session-file and diff routes.
 *
 * Endpoints:
 * - GET /tasks/:id/session-files
 * - GET /tasks/:id/diff
 * - GET /tasks/:id/file-diffs
 * - GET /tasks/:id/commit-associations
 */
export function registerSessionDiffRoutes(router: Router, deps: SessionDiffRouteDeps): void {
  const { getProjectContext } = deps;

  router.get("/tasks/:id/session-files", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      if (!task) {
        res.status(404).json({ error: "Task not found" });
        return;
      }

      const derivedBranchHint = task.branch?.trim() ? undefined : `fusion/${task.id.toLowerCase()}`;

      if (!task.worktree) {
        const files = await tryBranchRefFallbackFiles(task, scopedStore.getRootDir(), derivedBranchHint);
        sessionFilesCache.set(task.id, {
          files,
          expiresAt: Date.now() + 10000,
        });
        res.json(files);
        return;
      }

      let worktreeExists = false;
      try {
        await access(task.worktree);
        worktreeExists = true;
      } catch {
        worktreeExists = false;
      }

      if (!worktreeExists) {
        const files = await tryBranchRefFallbackFiles(task, scopedStore.getRootDir(), derivedBranchHint);
        sessionFilesCache.set(task.id, {
          files,
          expiresAt: Date.now() + 10000,
        });
        res.json(files);
        return;
      }

      const worktree = task.worktree;
      if (!(await worktreeStillBelongsToTask(worktree, task.branch))) {
        const files = await tryBranchRefFallbackFiles(task, scopedStore.getRootDir(), derivedBranchHint);
        sessionFilesCache.set(task.id, {
          files,
          expiresAt: Date.now() + 10000,
        });
        res.json(files);
        return;
      }
      const cached = sessionFilesCache.get(task.id);
      if (cached && cached.expiresAt > Date.now()) {
        res.json(cached.files);
        return;
      }

      let files: string[] = [];
      try {
        const fileSet = new Set<string>();
        const baseRef = await resolveDiffBase(task, worktree);

        if (baseRef) {
          const committedOutput = (await runGitCommand(["diff", "--name-only", `${baseRef}..HEAD`], worktree, 5000)).trim();
          for (const file of committedOutput.split("\n").filter(Boolean)) {
            fileSet.add(file);
          }
        }

        const stagedOutput = (await runGitCommand(["diff", "--cached", "--name-only"], worktree, 5000)).trim();
        for (const file of stagedOutput.split("\n").filter(Boolean)) {
          fileSet.add(file);
        }

        const workingTreeOutput = (await runGitCommand(["diff", "--name-only"], worktree, 5000)).trim();
        for (const file of workingTreeOutput.split("\n").filter(Boolean)) {
          fileSet.add(file);
        }

        const untrackedOutput = (await runGitCommand(["ls-files", "--others", "--exclude-standard"], worktree, 5000)).trim();
        for (const file of untrackedOutput.split("\n").filter(Boolean)) {
          fileSet.add(file);
        }

        files = Array.from(fileSet);
      } catch {
        files = [];
      }

      sessionFilesCache.set(task.id, {
        files,
        expiresAt: Date.now() + 10000,
      });

      res.json(files);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      }
      rethrowAsApiError(err, "Internal server error");
    }
  });

  router.get("/tasks/:id/diff", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      if (!task) {
        res.status(404).json({ error: "Task not found" });
        return;
      }

      // Workspace tasks have no singular worktree/branch; their changes live in
      // per-sub-repo worktrees. Aggregate across them (repo-prefixed paths) and
      // short-circuit before the single-repo logic, which would diff the non-git
      // workspace root and return empty.
      if (isWorkspaceTask(task)) {
        const workspaceFiles = await computeWorkspaceTaskFiles(task, scopedStore.getRootDir(), 10000);
        const files = workspaceFiles.map((file) => ({
          path: file.path,
          status: file.status === "renamed" ? "modified" : file.status,
          additions: file.additions,
          deletions: file.deletions,
          patch: file.patch,
        }));
        res.json({
          files,
          stats: {
            filesChanged: files.length,
            additions: files.reduce((sum, file) => sum + file.additions, 0),
            deletions: files.reduce((sum, file) => sum + file.deletions, 0),
          },
        });
        return;
      }

      if (task.column === "done") {
        const mergeShaForBaseBoundary = await resolveDoneTaskMergeSha(task, scopedStore, { includeBaseCommitSha: true });
        const resolvedMergeSha = await resolveDoneTaskMergeSha(task, scopedStore);
        if (mergeShaForBaseBoundary && task.baseCommitSha) {
          // FN-5666: `git diff A..B` is exclusive of A, and baseCommitSha is the
          // task fork point, so when resolved SHA is at/below base the task has
          // no owned changes to display.
          const atOrBelowBase = await isAtOrBelowTaskBase(mergeShaForBaseBoundary, task.baseCommitSha, scopedStore.getRootDir());
          if (atOrBelowBase) {
            res.json({ files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 } });
            return;
          }
        }

        const doneTaskForDiff = resolvedMergeSha
          ? {
              ...task,
              mergeDetails: {
                ...task.mergeDetails,
                commitSha: resolvedMergeSha,
              },
            }
          : task;

        const aggregated = await collectDoneTaskFiles(doneTaskForDiff, scopedStore);
        const expectedFilesChanged = task.mergeDetails?.filesChanged ?? 0;
        const aggregationLooksComplete = expectedFilesChanged <= 0 || aggregated.stats.filesChanged >= expectedFilesChanged;

        const rebaseBaseShaForAggregation = task.mergeDetails?.rebaseBaseSha?.trim();
        if (resolvedMergeSha && rebaseBaseShaForAggregation) {
          const rebaseDiffSpec = await resolveRebaseDiffSpec(rebaseBaseShaForAggregation, resolvedMergeSha, scopedStore.getRootDir());
          if (rebaseDiffSpec) {
            const rebaseRangeFiles = await collectDoneRangeFiles(rebaseDiffSpec.range, scopedStore.getRootDir()).catch(() => []);
            if (rebaseRangeFiles.length > 0) {
              const filtered = await restrictRebaseRangeFiles(task, rebaseRangeFiles, {
                rootDir: scopedStore.getRootDir(),
                rebaseBaseShaForAggregation,
                runGit: (args: string[]) => runGitCommand(args, scopedStore.getRootDir(), 10000),
              });
              const files = filtered.map((file) => ({
                ...file,
                status: file.status === "renamed" ? "modified" : file.status,
              }));
              res.json({
                files,
                stats: {
                  filesChanged: filtered.length,
                  additions: filtered.reduce((sum, file) => sum + file.additions, 0),
                  deletions: filtered.reduce((sum, file) => sum + file.deletions, 0),
                },
              });
              return;
            }
          }
        }

        if (aggregated.usedAggregation && aggregated.files.length > 0 && aggregationLooksComplete) {
          res.json({
            files: aggregated.files.map((file) => ({
              ...file,
              status: file.status === "renamed" ? "modified" : file.status,
            })),
            stats: aggregated.stats,
          });
          return;
        }

        if (aggregated.usedAggregation && aggregated.files.length > 0) {
          res.json({
            files: aggregated.files.map((file) => ({
              ...file,
              status: file.status === "renamed" ? "modified" : file.status,
            })),
            stats: aggregated.stats,
          });
          return;
        }

        if (!resolvedMergeSha) {
          // FN-4527: mergeDetails summary stats can be stale after post-merge
          // rebase-and-push (FN-4526). Never echo stored values from /diff.
          res.json({
            files: [],
            stats: {
              filesChanged: 0,
              additions: 0,
              deletions: 0,
            },
          });
          return;
        }

        const rootDir = scopedStore.getRootDir();
        const sha = resolvedMergeSha;

        let diffSpec: Awaited<ReturnType<typeof resolveCommitDiffSpec>> | { mode: "rebase-range"; base: string; range: string };
        const rebaseBaseSha = task.mergeDetails?.rebaseBaseSha?.trim();
        if (rebaseBaseSha) {
          const rebaseDiffSpec = await resolveRebaseDiffSpec(rebaseBaseSha, sha, rootDir);
          if (rebaseDiffSpec) {
            diffSpec = rebaseDiffSpec;
          } else {
            console.warn(`[diff] done task ${task.id}: mergeDetails.rebaseBaseSha ${rebaseBaseSha} is not ancestor of ${sha}; falling back to single-commit diff`);
            try {
              diffSpec = await resolveCommitDiffSpec(sha, rootDir);
            } catch {
              res.json({ files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 } });
              return;
            }
          }
        } else {
          try {
            diffSpec = await resolveCommitDiffSpec(sha, rootDir);
          } catch {
            res.json({ files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 } });
            return;
          }
        }

        const doneFiles = await collectDoneRangeFiles(diffSpec.range, rootDir).catch(() => []);
        if (doneFiles.length > 0) {
          const files = doneFiles.map((file) => ({
            ...file,
            status: file.status === "renamed" ? "modified" : file.status,
          }));
          res.json({
            files,
            stats: {
              filesChanged: files.length,
              additions: files.reduce((sum, file) => sum + file.additions, 0),
              deletions: files.reduce((sum, file) => sum + file.deletions, 0),
            },
          });
          return;
        }

        const shortstat = await runGitCommand(["show", "--shortstat", "--format=", resolvedMergeSha], rootDir, 10000)
          .then((output) => parseGitShortstat(output))
          .catch(() => ({ filesChanged: 0, additions: 0, deletions: 0 }));

        res.json({
          files: [],
          stats: shortstat,
        });
        return;
      }


      const worktree = typeof req.query.worktree === "string" ? req.query.worktree : undefined;
      const resolvedWorktree = worktree || task.worktree;
      const derivedBranchHint = task.branch?.trim() ? undefined : `fusion/${task.id.toLowerCase()}`;

      if (!resolvedWorktree) {
        const fallback = await tryBranchRefFallbackDetailedDiff(task, scopedStore.getRootDir(), derivedBranchHint);
        res.json(fallback);
        return;
      }
      let worktreeExists = false;
      try {
        await access(resolvedWorktree);
        worktreeExists = true;
      } catch {
        worktreeExists = false;
      }
      if (!worktreeExists) {
        const fallback = await tryBranchRefFallbackDetailedDiff(task, scopedStore.getRootDir(), derivedBranchHint);
        res.json(fallback);
        return;
      }
      if (!(await worktreeStillBelongsToTask(resolvedWorktree, task.branch))) {
        const fallback = await tryBranchRefFallbackDetailedDiff(task, scopedStore.getRootDir(), derivedBranchHint);
        res.json(fallback);
        return;
      }
      const cwd = resolvedWorktree;

      // Single-repo detailed diff (committed base..HEAD + staged + unstaged),
      // shared with the per-sub-repo workspace aggregation. Renames fold to
      // "modified" here (the /diff shape has no "renamed" status), matching the
      // previous inline behaviour.
      const detailed = await computeWorktreeDetailedFiles(task, cwd, 10000);
      const files = detailed.map((file) => ({
        path: file.path,
        status: file.status === "renamed" ? ("modified" as const) : file.status,
        additions: file.additions,
        deletions: file.deletions,
        patch: file.patch,
      }));

      const stats = {
        filesChanged: files.length,
        additions: files.reduce((sum, f) => sum + f.additions, 0),
        deletions: files.reduce((sum, f) => sum + f.deletions, 0),
      };

      res.json({ files, stats });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  router.get("/tasks/:id/file-diffs", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      if (!task) {
        res.status(404).json({ error: "Task not found" });
        return;
      }

      // Workspace tasks aggregate per-sub-repo patches (repo-prefixed paths);
      // short-circuit before the single-repo logic that diffs the non-git root.
      if (isWorkspaceTask(task)) {
        const workspaceFiles = (await computeWorkspaceTaskFiles(task, scopedStore.getRootDir(), 5000))
          .filter((file) => file.patch)
          .map((file) => (file.oldPath
            ? { path: file.path, status: file.status, diff: file.patch, oldPath: file.oldPath }
            : { path: file.path, status: file.status, diff: file.patch }));
        res.json(workspaceFiles);
        return;
      }

      if (task.column === "done") {
        const mergeShaForBaseBoundary = await resolveDoneTaskMergeSha(task, scopedStore, { includeBaseCommitSha: true });
        const resolvedMergeSha = await resolveDoneTaskMergeSha(task, scopedStore);
        if (mergeShaForBaseBoundary && task.baseCommitSha) {
          // FN-5666: baseCommitSha is the branch fork point and must remain
          // exclusive in per-task display diffs.
          const atOrBelowBase = await isAtOrBelowTaskBase(mergeShaForBaseBoundary, task.baseCommitSha, scopedStore.getRootDir());
          if (atOrBelowBase) {
            res.json([]);
            return;
          }
        }

        const doneTaskForDiff = resolvedMergeSha
          ? {
              ...task,
              mergeDetails: {
                ...task.mergeDetails,
                commitSha: resolvedMergeSha,
              },
            }
          : task;

        const aggregated = await collectDoneTaskFiles(doneTaskForDiff, scopedStore);
        const expectedFilesChanged = task.mergeDetails?.filesChanged ?? 0;
        const aggregationLooksComplete = expectedFilesChanged <= 0 || aggregated.stats.filesChanged >= expectedFilesChanged;

        const rebaseBaseShaForAggregation = task.mergeDetails?.rebaseBaseSha?.trim();
        if (resolvedMergeSha && rebaseBaseShaForAggregation) {
          const rebaseDiffSpec = await resolveRebaseDiffSpec(rebaseBaseShaForAggregation, resolvedMergeSha, scopedStore.getRootDir());
          if (rebaseDiffSpec) {
            const rebaseRangeFiles = await collectDoneRangeFiles(rebaseDiffSpec.range, scopedStore.getRootDir()).catch(() => []);
            if (rebaseRangeFiles.length > 0) {
              const filtered = await restrictRebaseRangeFiles(task, rebaseRangeFiles, {
                rootDir: scopedStore.getRootDir(),
                rebaseBaseShaForAggregation,
                runGit: (args: string[]) => runGitCommand(args, scopedStore.getRootDir(), 10000),
              });
              res.json(filtered.map((file) => ({ path: file.path, status: file.status, diff: file.patch })));
              return;
            }
          }
        }

        if (aggregated.usedAggregation && aggregated.files.length > 0 && aggregationLooksComplete) {
          res.json(aggregated.files.map((file) => ({ path: file.path, status: file.status, diff: file.patch })));
          return;
        }

        if (aggregated.usedAggregation && aggregated.files.length > 0) {
          res.json(aggregated.files.map((file) => ({ path: file.path, status: file.status, diff: file.patch })));
          return;
        }

        if (!resolvedMergeSha) {
          res.json([]);
          return;
        }

        const rootDir = scopedStore.getRootDir();
        const sha = resolvedMergeSha;

        let diffSpec: Awaited<ReturnType<typeof resolveCommitDiffSpec>> | { mode: "rebase-range"; base: string; range: string };
        const rebaseBaseSha = task.mergeDetails?.rebaseBaseSha?.trim();

        if (rebaseBaseSha) {
          const rebaseDiffSpec = await resolveRebaseDiffSpec(rebaseBaseSha, sha, rootDir);
          if (rebaseDiffSpec) {
            diffSpec = rebaseDiffSpec;
          } else {
            console.warn(`[file-diffs] done task ${task.id}: mergeDetails.rebaseBaseSha ${rebaseBaseSha} is not ancestor of ${sha}; falling back to single-commit diff`);
            try {
              diffSpec = await resolveCommitDiffSpec(sha, rootDir);
            } catch {
              res.json([]);
              return;
            }
          }
        } else {
          try {
            diffSpec = await resolveCommitDiffSpec(sha, rootDir);
          } catch {
            res.json([]);
            return;
          }
        }

        try {
          const doneFiles = await collectDoneRangeFiles(diffSpec.range, rootDir);
          res.json(doneFiles.map((file) => ({ path: file.path, status: file.status, diff: file.patch })));
        } catch {
          res.json([]);
        }
        return;
      }

      const derivedBranchHint = task.branch?.trim() ? undefined : `fusion/${task.id.toLowerCase()}`;

      if (!task.worktree) {
        const fallbackFiles = await tryBranchRefFallbackFileDiffs(task, scopedStore.getRootDir(), derivedBranchHint);
        fileDiffsCache.set(task.id, {
          files: fallbackFiles,
          expiresAt: Date.now() + 10000,
        });
        res.json(fallbackFiles);
        return;
      }

      let worktreeExists = false;
      try {
        await access(task.worktree);
        worktreeExists = true;
      } catch {
        worktreeExists = false;
      }

      if (!worktreeExists) {
        const fallbackFiles = await tryBranchRefFallbackFileDiffs(task, scopedStore.getRootDir(), derivedBranchHint);
        fileDiffsCache.set(task.id, {
          files: fallbackFiles,
          expiresAt: Date.now() + 10000,
        });
        res.json(fallbackFiles);
        return;
      }

      const worktree = task.worktree;
      if (!(await worktreeStillBelongsToTask(worktree, task.branch))) {
        const fallbackFiles = await tryBranchRefFallbackFileDiffs(task, scopedStore.getRootDir(), derivedBranchHint);
        fileDiffsCache.set(task.id, {
          files: fallbackFiles,
          expiresAt: Date.now() + 10000,
        });
        res.json(fallbackFiles);
        return;
      }
      const cached = fileDiffsCache.get(task.id);
      if (cached && cached.expiresAt > Date.now()) {
        res.json(cached.files);
        return;
      }

      const cwd = worktree;

      // Single-repo per-file patches (committed base..HEAD + staged + unstaged),
      // shared with the per-sub-repo workspace aggregation. Files with an empty
      // patch (e.g. pure renames with no content change) are dropped, matching
      // the previous inline behaviour.
      const detailed = await computeWorktreeDetailedFiles(task, cwd, 5000);
      const files = detailed
        .filter((file) => file.patch)
        .map((file) => (file.oldPath
          ? { path: file.path, status: file.status, diff: file.patch, oldPath: file.oldPath }
          : { path: file.path, status: file.status, diff: file.patch }));

      fileDiffsCache.set(task.id, {
        files,
        expiresAt: Date.now() + 10000,
      });

      res.json(files);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      }
      rethrowAsApiError(err, "Internal server error");
    }
  });

  router.get("/tasks/:id/commit-associations", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      if (!task) {
        res.status(404).json({ error: "Task not found" });
        return;
      }

      if (!task.lineageId) {
        res.json({
          taskId: task.id,
          lineageId: null,
          associations: [],
        });
        return;
      }

      const associations = await scopedStore.getTaskCommitAssociationsByLineageId(task.lineageId);
      res.json({
        taskId: task.id,
        lineageId: task.lineageId,
        associations: associations.map((association) => ({
          commitSha: association.commitSha,
          commitSubject: association.commitSubject,
          authoredAt: association.authoredAt,
          matchedBy: association.matchedBy,
          confidence: association.confidence,
          taskIdSnapshot: association.taskIdSnapshot,
          note: association.note,
        })),
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      }
      rethrowAsApiError(err, "Internal server error");
    }
  });
}
