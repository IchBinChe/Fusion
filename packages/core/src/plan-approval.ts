import type { ProjectSettings } from "./types.js";

export type PlanApprovalMode = NonNullable<ProjectSettings["planApprovalMode"]>;

/**
 * FNXC:PlanApproval 2026-06-26-00:00:
 * Per-project planApprovalMode controls the planning approval gate for every task in the project: require-all always parks approved specs for manual approval, auto-approve-all always bypasses the gate, and workflow/undefined preserves the workflow-resolved requirePlanApproval value.
 */
export function resolvePlanApprovalRequired(
  settings: Pick<ProjectSettings, "planApprovalMode" | "requirePlanApproval">,
): boolean {
  switch (settings.planApprovalMode) {
    case "require-all":
      return true;
    case "auto-approve-all":
      return false;
    case "workflow":
    default:
      return Boolean(settings.requirePlanApproval);
  }
}
