import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, copyFileSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);

export type SyncMode = "ff-only" | "stash-and-ff";

export interface WorktreeSyncAuditEvent {
  mutationType: "pull:fast-forward" | "stash:push" | "stash:pop" | "stash:pop-conflict";
  metadata: Record<string, unknown>;
}

export type WorktreeSyncAuditEmitter = (event: WorktreeSyncAuditEvent) => void | Promise<void>;

export interface SyncWorktreeInput {
  worktreePath: string;
  integrationBranch: string;
  previousSha: string;
  newSha: string;
  mode: SyncMode;
  taskId?: string;
  emit?: WorktreeSyncAuditEmitter;
}

export type SyncWorktreeResult =
  | { kind: "clean-sync"; fromSha: string; toSha: string }
  | { kind: "synced-with-edits-restored"; fromSha: string; toSha: string; stashedFiles: string[]; untrackedRestored: string[] }
  | { kind: "synced-with-pop-conflict"; fromSha: string; toSha: string; stashedFiles: string[]; conflictedFiles: string[]; patchPath: string }
  | { kind: "skipped-dirty"; fromSha: string; reason: "ff-only-mode-requires-clean-tree"; dirtyFiles: string[]; untrackedFiles: string[] }
  | { kind: "skipped-not-on-branch"; currentBranch: string }
  | { kind: "skipped-head-not-at-new-sha"; currentSha: string; expectedNewSha: string }
  | { kind: "failed"; stage: "snapshot" | "reset" | "apply" | "untracked-restore"; error: string };

async function runGit(args: string[], cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync("git", args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    encoding: "utf-8",
  });
  if (typeof result === "string") return { stdout: result, stderr: "" };
  if (result && typeof result === "object") {
    return {
      stdout: String((result as { stdout?: unknown }).stdout ?? ""),
      stderr: String((result as { stderr?: unknown }).stderr ?? ""),
    };
  }
  return { stdout: "", stderr: "" };
}

function commandError(err: unknown): string {
  if (err instanceof Error) {
    const anyErr = err as Error & { stdout?: string; stderr?: string };
    return [anyErr.stderr, anyErr.stdout, anyErr.message].filter(Boolean).join("\n").trim() || anyErr.message;
  }
  return String(err);
}

async function listFiles(cwd: string, args: string[]): Promise<string[]> {
  try {
    const { stdout } = await runGit(args, cwd, 10_000);
    return stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

/**
 * Bring a worktree's index + files forward to its current HEAD after the
 * integration-branch ref was advanced *locally* (typically by the merger via
 * `git update-ref`). This is NOT a `git pull` — origin may still be at the old
 * tip, so a pull would be a no-op and would leave the worktree pinned to the
 * stale state.
 *
 * Strategy:
 *   1. Compare worktree contents against `previousSha` to isolate the user's
 *      *real* edits from the stale-index "phantom diff" against the new HEAD.
 *   2. If no real edits and no untracked files exist, `git reset --hard HEAD`
 *      cleanly snaps both the index and the working tree forward to `newSha`.
 *   3. With real edits in `stash-and-ff` mode, capture them as a binary patch
 *      against `previousSha`, copy untracked files to a temp dir, snap to
 *      HEAD, then reapply (`git apply --3way`) and restore untracked. Patch
 *      conflicts surface as `synced-with-pop-conflict` and the patch is left
 *      on disk for manual recovery.
 *
 * In `ff-only` mode any real edits cause the function to bail with
 * `skipped-dirty`; the caller is expected to surface the Merge Advance Notice
 * banner so the user can handle the worktree by hand.
 */
export async function syncWorktreeToHead(input: SyncWorktreeInput): Promise<SyncWorktreeResult> {
  const { worktreePath, integrationBranch, previousSha, newSha, mode, taskId, emit } = input;
  const emitSafe = async (event: WorktreeSyncAuditEvent): Promise<void> => {
    if (!emit) return;
    try {
      await emit(event);
    } catch {
      // never let audit emission abort the sync
    }
  };

  // Guards.
  const branch = (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath, 5_000)).stdout.trim();
  if (branch !== integrationBranch) {
    return { kind: "skipped-not-on-branch", currentBranch: branch };
  }
  const headSha = (await runGit(["rev-parse", "HEAD"], worktreePath, 5_000)).stdout.trim();
  if (headSha !== newSha) {
    // The ref already moved past `newSha` (or hasn't reached it). Bail rather
    // than risk a partial reconciliation against a moving target.
    return { kind: "skipped-head-not-at-new-sha", currentSha: headSha, expectedNewSha: newSha };
  }

  // Snapshot real edits against `previousSha` (which is the tree the worktree
  // *should* currently match if no one touched it after the ref advance).
  let dirtyFiles: string[];
  let untrackedFiles: string[];
  try {
    dirtyFiles = await listFiles(worktreePath, ["diff", "--name-only", previousSha]);
    untrackedFiles = await listFiles(worktreePath, ["ls-files", "--others", "--exclude-standard"]);
  } catch (err: unknown) {
    return { kind: "failed", stage: "snapshot", error: commandError(err) };
  }
  const hasRealEdits = dirtyFiles.length > 0 || untrackedFiles.length > 0;

  if (!hasRealEdits) {
    try {
      await runGit(["reset", "--hard", "HEAD"], worktreePath, 30_000);
    } catch (err: unknown) {
      return { kind: "failed", stage: "reset", error: commandError(err) };
    }
    await emitSafe({
      mutationType: "pull:fast-forward",
      metadata: { taskId, worktreePath, integrationBranch, fromSha: previousSha, toSha: newSha, succeeded: true, kind: "clean-sync" },
    });
    return { kind: "clean-sync", fromSha: previousSha, toSha: newSha };
  }

  if (mode === "ff-only") {
    return { kind: "skipped-dirty", fromSha: previousSha, reason: "ff-only-mode-requires-clean-tree", dirtyFiles, untrackedFiles };
  }

  // stash-and-ff: snapshot real edits + untracked, snap, restore.
  const stageDir = mkdtempSync(join(tmpdir(), "fusion-worktree-sync-"));
  const patchPath = join(stageDir, "edits.patch");
  const untrackedDir = join(stageDir, "untracked");
  try {
    mkdirSync(untrackedDir, { recursive: true });

    // 1. Diff against previousSha (binary, full-file) captures only real edits.
    let patch = "";
    if (dirtyFiles.length > 0) {
      const { stdout } = await runGit(["diff", "--binary", "--no-color", previousSha], worktreePath, 60_000);
      patch = stdout;
    }

    // 2. Save untracked files.
    for (const rel of untrackedFiles) {
      const src = join(worktreePath, rel);
      const dst = join(untrackedDir, rel);
      mkdirSync(dirname(dst), { recursive: true });
      try {
        copyFileSync(src, dst);
      } catch {
        // best-effort; missing entries skipped
      }
    }

    await emitSafe({
      mutationType: "stash:push",
      metadata: {
        taskId,
        worktreePath,
        stashedFiles: dirtyFiles,
        untrackedCount: untrackedFiles.length,
        patchPath,
        kind: "patch-snapshot",
      },
    });

    // 3. Snap worktree+index to HEAD (NEW).
    try {
      await runGit(["reset", "--hard", "HEAD"], worktreePath, 30_000);
    } catch (err: unknown) {
      return { kind: "failed", stage: "reset", error: commandError(err) };
    }
    await emitSafe({
      mutationType: "pull:fast-forward",
      metadata: { taskId, worktreePath, integrationBranch, fromSha: previousSha, toSha: newSha, succeeded: true, kind: "snap-after-snapshot" },
    });

    // 4. Reapply patch.
    let popConflict = false;
    const conflictedFiles: string[] = [];
    if (patch.length > 0) {
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn("git", ["apply", "--3way", "--whitespace=nowarn"], { cwd: worktreePath });
          let stderr = "";
          child.stderr.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); });
          child.on("error", reject);
          child.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`git apply exited with code ${code}: ${stderr}`));
          });
          child.stdin.write(patch);
          child.stdin.end();
        });
      } catch (err: unknown) {
        // Persist patch for manual recovery and surface a structured conflict.
        try {
          await import("node:fs").then((fs) => fs.writeFileSync(patchPath, patch));
        } catch {
          // best-effort
        }
        popConflict = true;
        const conflicts = await listFiles(worktreePath, ["diff", "--name-only", "--diff-filter=U"]);
        for (const c of conflicts) conflictedFiles.push(c);
        await emitSafe({
          mutationType: "stash:pop-conflict",
          metadata: {
            taskId,
            worktreePath,
            patchPath,
            conflictedFiles,
            kind: "patch-apply-conflict",
            error: commandError(err),
            advice: `Real edits were saved to ${patchPath}. Apply manually with \`git apply --3way ${patchPath}\` after resolving conflicts.`,
          },
        });
      }
    }

    // 5. Restore untracked files.
    const restored: string[] = [];
    for (const rel of untrackedFiles) {
      const src = join(untrackedDir, rel);
      const dst = join(worktreePath, rel);
      if (!existsSync(src)) continue;
      try {
        mkdirSync(dirname(dst), { recursive: true });
        const data = readFileSync(src);
        await import("node:fs").then((fs) => fs.writeFileSync(dst, data));
        restored.push(rel);
      } catch {
        // best-effort
      }
    }

    if (popConflict) {
      // Keep stageDir so the patch survives for manual recovery.
      return { kind: "synced-with-pop-conflict", fromSha: previousSha, toSha: newSha, stashedFiles: dirtyFiles, conflictedFiles, patchPath };
    }

    // Clean: emit stash:pop and clean up the stage dir.
    await emitSafe({
      mutationType: "stash:pop",
      metadata: { taskId, worktreePath, stashedFiles: dirtyFiles, untrackedRestored: restored, kind: "patch-applied" },
    });
    try {
      rmSync(stageDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    return { kind: "synced-with-edits-restored", fromSha: previousSha, toSha: newSha, stashedFiles: dirtyFiles, untrackedRestored: restored };
  } catch (err: unknown) {
    return { kind: "failed", stage: "apply", error: commandError(err) };
  }
}
