import { describe, expect, it } from "vitest";
import {
  canAgentTakeImplementationTask,
  canAgentTakeImplementationTaskForBacklogPickup,
  canAgentTakeImplementationTaskForExplicitRouting,
  formatRoleMismatchReason,
  isEngineerRoleAgent,
  isExecutorRoleAgent,
  isImplementationTask,
} from "../agent-role-policy.js";

describe("agent-role-policy", () => {
  it("treats triage/todo/in-progress/in-review as implementation tasks", () => {
    expect(isImplementationTask({ column: "triage" })).toBe(true);
    expect(isImplementationTask({ column: "todo" })).toBe(true);
    expect(isImplementationTask({ column: "in-progress" })).toBe(true);
    expect(isImplementationTask({ column: "in-review" })).toBe(true);
  });

  it("does not treat done/archived as implementation tasks", () => {
    expect(isImplementationTask({ column: "done" })).toBe(false);
    expect(isImplementationTask({ column: "archived" })).toBe(false);
  });

  it("allows executor agents in both explicit routing and backlog pickup", () => {
    expect(isExecutorRoleAgent({ role: "executor" })).toBe(true);
    expect(
      canAgentTakeImplementationTaskForExplicitRouting({ role: "executor" }, { column: "todo" }),
    ).toBe(true);
    expect(
      canAgentTakeImplementationTaskForBacklogPickup({ role: "executor" }, { column: "todo" }),
    ).toBe(true);
    expect(
      canAgentTakeImplementationTaskForBacklogPickup({ role: "executor" }, { column: "todo" }, { allowEngineer: true }),
    ).toBe(true);
    expect(
      canAgentTakeImplementationTask({ role: "executor" }, { column: "todo" }, { allowEngineer: true }),
    ).toBe(true);
  });

  it("allows durable engineer for explicit routing and opt-in backlog pickup only", () => {
    expect(isEngineerRoleAgent({ role: "engineer" })).toBe(true);
    expect(
      canAgentTakeImplementationTaskForExplicitRouting({ role: "engineer" }, { column: "todo" }),
    ).toBe(true);
    expect(
      canAgentTakeImplementationTaskForBacklogPickup({ role: "engineer" }, { column: "todo" }),
    ).toBe(false);
    expect(
      canAgentTakeImplementationTask({ role: "engineer" }, { column: "todo" }),
    ).toBe(false);
    expect(
      canAgentTakeImplementationTaskForBacklogPickup({ role: "engineer" }, { column: "todo" }, { allowEngineer: true }),
    ).toBe(true);
    expect(
      canAgentTakeImplementationTask({ role: "engineer" }, { column: "todo" }, { allowEngineer: true }),
    ).toBe(true);
  });

  it("keeps reviewer and custom roles blocked from backlog pickup even when engineers opt in", () => {
    expect(isExecutorRoleAgent({ role: "reviewer" })).toBe(false);
    expect(
      canAgentTakeImplementationTaskForExplicitRouting({ role: "reviewer" }, { column: "todo" }),
    ).toBe(false);
    expect(
      canAgentTakeImplementationTaskForBacklogPickup({ role: "reviewer" }, { column: "todo" }),
    ).toBe(false);
    expect(
      canAgentTakeImplementationTaskForBacklogPickup({ role: "reviewer" }, { column: "todo" }, { allowEngineer: true }),
    ).toBe(false);
    expect(
      canAgentTakeImplementationTaskForBacklogPickup({ role: "custom" }, { column: "todo" }, { allowEngineer: true }),
    ).toBe(false);
  });

  it("does not gate non-implementation columns by role", () => {
    expect(
      canAgentTakeImplementationTaskForBacklogPickup({ role: "reviewer" }, { column: "done" }),
    ).toBe(true);
    expect(
      canAgentTakeImplementationTaskForBacklogPickup({ role: "custom" }, { column: "archived" }, { allowEngineer: true }),
    ).toBe(true);
  });

  it("formats mismatch reason with agent/task details", () => {
    const reason = formatRoleMismatchReason(
      { id: "agent-1", role: "reviewer" },
      { id: "FN-123", column: "todo" },
    );
    expect(reason).toContain("agent-1");
    expect(reason).toContain("reviewer");
    expect(reason).toContain("FN-123");
    expect(reason).toContain("requires an \"executor\"-role agent by default");
    expect(reason).toContain("durable \"engineer\" supported only for explicit routing");
  });
});
