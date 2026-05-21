export type ActiveSessionKind = "executor" | "step-session" | "workflow-step" | "step-session-parallel";

export interface ActiveSessionRegistration {
  taskId: string;
  kind: ActiveSessionKind;
  ownerKey: string;
}

export interface ActiveSessionRecord extends ActiveSessionRegistration {
  registeredAt: number;
}

export interface ReconcileStaleSelfOwnedResult {
  reconciled: boolean;
  reason: "no-entry" | "foreign-task" | "reconciled";
}

export type LiveBindingProbe = (worktreePath: string, taskId: string) => boolean;

export type SelfOwnedReconcileOutcome =
  | { action: "no-entry" }
  | { action: "foreign-task"; ownerTaskId: string }
  | { action: "live-binding-refuses"; ownerTaskId: string }
  | { action: "reconciled" };

export class ActiveSessionRegistry {
  private readonly records = new Map<string, ActiveSessionRecord>();

  registerPath(worktreePath: string, registration: ActiveSessionRegistration): void {
    if (this.records.has(worktreePath)) {
      console.warn(`[active-session-registry] overwriting existing registration for ${worktreePath}`);
    }
    this.records.set(worktreePath, {
      ...registration,
      registeredAt: Date.now(),
    });
  }

  unregisterPath(worktreePath: string): void {
    this.records.delete(worktreePath);
  }

  lookupByPath(worktreePath: string): ActiveSessionRecord | null {
    return this.records.get(worktreePath) ?? null;
  }

  isPathActive(worktreePath: string): boolean {
    return this.records.has(worktreePath);
  }

  pathsForTask(taskId: string): string[] {
    const paths: string[] = [];
    for (const [path, record] of this.records.entries()) {
      if (record.taskId === taskId) {
        paths.push(path);
      }
    }
    return paths;
  }

  reconcileStaleSelfOwned(worktreePath: string, expectedTaskId: string): ReconcileStaleSelfOwnedResult {
    const record = this.lookupByPath(worktreePath);
    if (!record) {
      return { reconciled: false, reason: "no-entry" };
    }
    if (record.taskId !== expectedTaskId) {
      return { reconciled: false, reason: "foreign-task" };
    }

    this.unregisterPath(worktreePath);
    return { reconciled: true, reason: "reconciled" };
  }

  clear(): void {
    this.records.clear();
  }
}

export function reconcileSelfOwnedActiveSessionForRemoval(
  registry: ActiveSessionRegistry,
  worktreePath: string,
  requestingTaskId: string,
  liveBindingProbe: LiveBindingProbe,
): SelfOwnedReconcileOutcome {
  const record = registry.lookupByPath(worktreePath);
  if (!record) {
    return { action: "no-entry" };
  }

  if (record.taskId !== requestingTaskId) {
    return { action: "foreign-task", ownerTaskId: record.taskId };
  }

  if (liveBindingProbe(worktreePath, requestingTaskId)) {
    return { action: "live-binding-refuses", ownerTaskId: requestingTaskId };
  }

  registry.unregisterPath(worktreePath);
  return { action: "reconciled" };
}

export const activeSessionRegistry = new ActiveSessionRegistry();

/**
 * FN-4811 follow-up: process-wide "executing" lock for `TaskExecutor.execute()`.
 *
 * Per-instance `executing: Set<string>` is insufficient when there can be more than
 * one TaskExecutor instance in the same Node process (e.g., multi-project setups,
 * engine restarts that race with old instance teardown, hybrid-executor path).
 * Production failure shape: two execute() invocations for the same task ID both
 * generated runIds (y2nb + 9gde for FN-4809), both reached "Executor detected stale
 * merge state" (executor.ts:2661), both attempted worktree creation — producing
 * duplicate "Worktree created at /..." log entries within the same second
 * (FN-4809, FN-4814, FN-4781, FN-4804, FN-4811).
 *
 * This module-level Set is shared across all TaskExecutor instances in the process,
 * providing a process-wide claim. Values are taskId strings; presence means
 * "someone is actively executing this task". Callers MUST claim synchronously
 * via `tryClaim()` and MUST release on every exit path.
 */
const executingTasks = new Set<string>();

export const executingTaskLock = {
  has(taskId: string): boolean {
    return executingTasks.has(taskId);
  },
  /** Synchronously claim the lock. Returns true if claimed, false if already held. */
  tryClaim(taskId: string): boolean {
    if (executingTasks.has(taskId)) return false;
    executingTasks.add(taskId);
    return true;
  },
  release(taskId: string): void {
    executingTasks.delete(taskId);
  },
  /** Test-only: clear all entries. */
  _clearForTest(): void {
    executingTasks.clear();
  },
};
