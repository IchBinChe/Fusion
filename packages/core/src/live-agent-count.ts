export type RunningAgentCountSource = (projectIds: readonly string[]) => Promise<Record<string, number>> | Record<string, number>;

let runningAgentCountSource: RunningAgentCountSource | undefined;

/**
 * FNXC:GlobalConcurrencyControls 2026-06-26-17:22:
 * Live running-agent counts must come from side-effect-safe reads of `in-progress` task columns, not from stale slot or health bookkeeping. This DI seam lets dashboard, CLI, remote-node, and plugin consumers share one core path without starting project engines/runtimes, opening watchers, or mutating `globalConcurrency.currentlyActive`, `globalConcurrency.queuedCount`, or `projectHealth.inFlightAgentCount`.
 */
export function setRunningAgentCountSource(fn: RunningAgentCountSource | undefined): void {
  runningAgentCountSource = fn;
}

/**
 * Returns the registered side-effect-safe running-agent count source, if one has been wired by the host process.
 */
export function getRunningAgentCountSource(): RunningAgentCountSource | undefined {
  return runningAgentCountSource;
}

export interface RunningAgentCounts {
  currentlyActive: number;
  projectsActive: Record<string, number>;
}

export function deriveRunningAgentCounts(perProject: Record<string, number>): RunningAgentCounts {
  const projectsActive: Record<string, number> = {};
  let currentlyActive = 0;

  for (const [projectId, rawCount] of Object.entries(perProject)) {
    const count = Number.isFinite(rawCount) ? Math.max(0, Math.trunc(rawCount)) : 0;
    currentlyActive += count;
    if (count > 0) {
      projectsActive[projectId] = count;
    }
  }

  return { currentlyActive, projectsActive };
}
