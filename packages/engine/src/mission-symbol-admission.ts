import {
  evaluateMissionLineageApproval,
  resolveTaskSymbolsForTask,
  type AsyncMissionStore,
  type MissionFeature,
  type MissionLineageApprovalReason,
  type MissionStore,
  type Task,
} from "@fusion/core";

/** The only scheduler admission modes for implementation work. */
export type MissionSymbolAdmissionDecision =
  | {
    kind: "symbol-lock";
    symbols: string[];
    feature: MissionFeature;
    reason: "approved";
  }
  | {
    kind: "lineage-blocked";
    reason: Exclude<MissionLineageApprovalReason, "approved">;
  }
  | {
    kind: "coarse-fallback";
    reason: "non-mission" | "symbols-unresolvable";
  };

export interface MissionSymbolAdmissionOptions {
  /** Plan approval is policy-owned; the canonical predicate owns fingerprint validation. */
  planApprovalRequired?: boolean;
}

type MissionReader = Pick<
  MissionStore | AsyncMissionStore,
  "getMission" | "getMilestone" | "getSlice" | "getFeatureByTaskId"
>;

/**
 * Resolve the canonical feature link rather than title matching: scheduler
 * admission must fail closed for mission work whose hierarchy cannot be proven.
 */
async function resolveFeature(store: MissionReader, task: Task): Promise<MissionFeature | undefined> {
  return await store.getFeatureByTaskId(task.id);
}

/**
 * FNXC:MissionSymbolAdmission 2026-07-31-12:00:
 * FN-8306 makes autonomous implementation a three-way contract using
 * evaluateMissionLineageApproval: approved mission lineage with durable symbols
 * uses a symbol lock; mission-linked work that cannot prove active
 * Mission→Milestone→Slice→Feature lineage is blocked; only non-mission work or
 * approved work with no resolvable symbols retains coarse file-scope admission.
 * This function is deliberately side-effect free so no blocked decision can
 * consume a work or symbol lease.
 */
export async function decideMissionSymbolAdmission(
  task: Task,
  missionStore: MissionReader | undefined,
  options: MissionSymbolAdmissionOptions = {},
): Promise<MissionSymbolAdmissionDecision> {
  const declaredMissionLink = Boolean(task.missionId || task.sliceId);
  if (!missionStore) {
    return declaredMissionLink
      ? { kind: "lineage-blocked", reason: "missing-feature" }
      : { kind: "coarse-fallback", reason: "non-mission" };
  }

  const feature = await resolveFeature(missionStore, task);
  const missionLinked = declaredMissionLink || Boolean(feature);
  if (!missionLinked) return { kind: "coarse-fallback", reason: "non-mission" };
  // Resolve every stated lineage edge independently so diagnostics distinguish
  // a missing feature from a missing parent rather than collapsing to the first
  // child lookup that happened to be unavailable.
  const sliceId = feature?.sliceId ?? task.sliceId;
  const slice = sliceId ? await missionStore.getSlice(sliceId) : undefined;
  const milestone = slice ? await missionStore.getMilestone(slice.milestoneId) : undefined;
  const missionId = milestone?.missionId ?? task.missionId;
  const mission = missionId ? await missionStore.getMission(missionId) : undefined;
  const approval = evaluateMissionLineageApproval({
    task,
    feature,
    slice,
    milestone,
    mission,
    planApprovalRequired: options.planApprovalRequired === true,
  });
  if (!approval.approved) return { kind: "lineage-blocked", reason: approval.reason };

  const symbols = resolveTaskSymbolsForTask(task);
  if (!symbols.resolvable || symbols.symbols.length === 0) {
    return { kind: "coarse-fallback", reason: "symbols-unresolvable" };
  }
  return { kind: "symbol-lock", symbols: symbols.symbols, feature: feature!, reason: "approved" };
}
