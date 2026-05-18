import { findDuplicateMatches } from "./duplicate-detection.js";
import type { Column } from "./types.js";
import type { TaskStore } from "./store.js";

export interface SameAgentDuplicateInput {
  title?: string | null;
  description: string;
}

export interface SameAgentDuplicateCandidate {
  id: string;
  title: string;
  description: string;
  column: Column;
  createdAt: number;
  sourceAgentId: string | null;
}

export interface SameAgentDuplicateMatch {
  id: string;
  score: number;
}

export function findSameAgentDuplicates(
  input: SameAgentDuplicateInput,
  candidates: SameAgentDuplicateCandidate[],
  opts?: { threshold?: number; nowMs?: number; windowMs?: number },
): SameAgentDuplicateMatch[] {
  const threshold = opts?.threshold ?? 0.75;
  const nowMs = opts?.nowMs ?? Date.now();
  const windowMs = opts?.windowMs ?? 24 * 60 * 60 * 1000;
  const cutoff = nowMs - windowMs;

  const recent = candidates.filter((candidate) => candidate.createdAt >= cutoff && candidate.sourceAgentId != null);

  const matches = findDuplicateMatches(
    { title: input.title ?? undefined, description: input.description },
    recent.map((candidate) => ({
      id: candidate.id,
      title: candidate.title,
      description: candidate.description,
      column: candidate.column,
    })),
    { threshold },
  );

  return matches.map((match) => ({ id: match.id, score: match.score }));
}

export async function archiveAsSameAgentDuplicate(
  store: TaskStore,
  taskId: string,
  siblingIds: string[],
  scores: Record<string, number>,
): Promise<void> {
  await store.logEntry(
    taskId,
    "Auto-archived as same-agent duplicate",
    `Duplicate of recently-filed sibling task(s): ${siblingIds.join(", ")}`,
  );
  // FN-4892: store-side intake path does activity-only emission; run-audit requires runId+agentId context from engine callers.
  await store.recordActivity({
    type: "task:auto-archived-duplicate",
    taskId,
    details: "Auto-archived as same-agent duplicate during intake",
    metadata: { siblingTaskIds: siblingIds, scores },
  });
  await store.moveTask(taskId, "archived");
}
