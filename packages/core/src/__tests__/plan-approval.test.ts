import { describe, expect, it } from "vitest";
import { resolvePlanApprovalRequired, type PlanApprovalMode } from "../plan-approval.js";

const workflowValues = [true, false, undefined] as const;

describe("resolvePlanApprovalRequired", () => {
  it.each(workflowValues)("defers to requirePlanApproval when mode is workflow and workflow value is %s", (requirePlanApproval) => {
    expect(resolvePlanApprovalRequired({ planApprovalMode: "workflow", requirePlanApproval })).toBe(Boolean(requirePlanApproval));
  });

  it.each(workflowValues)("defers to requirePlanApproval when mode is undefined and workflow value is %s", (requirePlanApproval) => {
    expect(resolvePlanApprovalRequired({ requirePlanApproval })).toBe(Boolean(requirePlanApproval));
  });

  it.each(workflowValues)("auto-approve-all bypasses approval when workflow value is %s", (requirePlanApproval) => {
    expect(resolvePlanApprovalRequired({ planApprovalMode: "auto-approve-all", requirePlanApproval })).toBe(false);
  });

  it.each(workflowValues)("require-all requires approval when workflow value is %s", (requirePlanApproval) => {
    expect(resolvePlanApprovalRequired({ planApprovalMode: "require-all", requirePlanApproval })).toBe(true);
  });

  it("falls back to workflow behavior for unknown persisted modes", () => {
    expect(
      resolvePlanApprovalRequired({
        planApprovalMode: "future-mode" as PlanApprovalMode,
        requirePlanApproval: true,
      }),
    ).toBe(true);
    expect(
      resolvePlanApprovalRequired({
        planApprovalMode: "future-mode" as PlanApprovalMode,
        requirePlanApproval: false,
      }),
    ).toBe(false);
  });
});
