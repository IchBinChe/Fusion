import { describe, expect, it } from "vitest";
import { resolveQuickAddStartTargetColumn, validateQuickAddStartWorkflow, workflowSupportsQuickAddStart } from "../quickAddStart";

const workflow = (overrides: Record<string, unknown> = {}) => ({
  id: "custom",
  name: "Custom",
  columns: [
    { id: "ideas", name: "Ideas", flags: { hold: true } },
    { id: "todo", name: "Todo", flags: {} },
    { id: "done", name: "Done", flags: { complete: true } },
  ],
  ...overrides,
});

describe("quick add Start workflow guards", () => {
  it("requires complete runtime metadata before builtin or hold eligibility", () => {
    expect(workflowSupportsQuickAddStart(validateQuickAddStartWorkflow(workflow({ id: "builtin:coding-ideas" })))).toBe(true);
    expect(workflowSupportsQuickAddStart(validateQuickAddStartWorkflow(workflow()))).toBe(true);
    expect(validateQuickAddStartWorkflow(workflow({ id: "__all_workflows__" }))).toBeNull();
    expect(validateQuickAddStartWorkflow(workflow({ columns: [] }))).toBeNull();
    expect(validateQuickAddStartWorkflow(workflow({ columns: [{ id: "", flags: {} }] }))).toBeNull();
    expect(validateQuickAddStartWorkflow(workflow({ columns: [{ id: "a", flags: {} }, { id: "a", flags: {} }] }))).toBeNull();
    expect(validateQuickAddStartWorkflow(workflow({ columns: [{ id: "a", flags: null }] }))).toBeNull();
  });

  it("only chooses a later visible working destination", () => {
    const valid = validateQuickAddStartWorkflow(workflow({ columns: [
      { id: "ideas", name: "Ideas", flags: { hold: true } },
      { id: "review", name: "Review", flags: { hold: true } },
      { id: "done", name: "Done", flags: { complete: true } },
      { id: "todo", name: "Todo", flags: {} },
    ] }));
    expect(valid).not.toBeNull();
    expect(resolveQuickAddStartTargetColumn(valid!, "ideas")).toBe("todo");
    expect(resolveQuickAddStartTargetColumn(valid!, "todo")).toBeNull();
    expect(resolveQuickAddStartTargetColumn(valid!, "unknown")).toBeNull();
  });
});
