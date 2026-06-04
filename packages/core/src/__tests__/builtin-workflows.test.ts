import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { BUILTIN_WORKFLOWS, getBuiltinWorkflow, isBuiltinWorkflowId } from "../builtin-workflows.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../builtin-coding-workflow-ir.js";
import { compileWorkflowToSteps } from "../workflow-compiler.js";
import { DEFAULT_WORKFLOW_COLUMN_IDS, parseWorkflowIr } from "../workflow-ir.js";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";

describe("built-in workflows", () => {
  it("every built-in has a valid IR and compiles without error", () => {
    expect(BUILTIN_WORKFLOWS.length).toBeGreaterThanOrEqual(4);
    for (const wf of BUILTIN_WORKFLOWS) {
      expect(isBuiltinWorkflowId(wf.id)).toBe(true);
      expect(() => parseWorkflowIr(wf.ir)).not.toThrow();
      expect(() => compileWorkflowToSteps(wf.ir)).not.toThrow();
    }
  });

  it("default workflow column ids equal the legacy enum values, in legacy order (KTD-1)", () => {
    expect(BUILTIN_CODING_WORKFLOW_IR.version).toBe("v2");
    if (BUILTIN_CODING_WORKFLOW_IR.version !== "v2") throw new Error("expected v2");
    expect(BUILTIN_CODING_WORKFLOW_IR.columns.map((c) => c.id)).toEqual([
      ...DEFAULT_WORKFLOW_COLUMN_IDS,
    ]);
  });

  it("includes a coding and a compound-engineering workflow", () => {
    expect(getBuiltinWorkflow("builtin:coding")).toBeDefined();
    expect(getBuiltinWorkflow("builtin:compound-engineering")).toBeDefined();
  });

  it("compound-engineering compiles its skill nodes to steps", () => {
    const ce = getBuiltinWorkflow("builtin:compound-engineering")!;
    const steps = compileWorkflowToSteps(ce.ir);
    // plan + code-review (pre-merge) + document (post-merge) — seams are skipped.
    expect(steps.length).toBeGreaterThanOrEqual(3);
    expect(steps.some((s) => s.name === "Plan")).toBe(true);
  });

  describe("store integration", () => {
    const harness = createTaskStoreTestHarness();
    let store: ReturnType<typeof harness.store>;
    beforeEach(async () => {
      await harness.beforeEach();
      store = harness.store();
    });
    afterEach(async () => {
      await harness.afterEach();
    });

    it("lists built-ins ahead of user workflows and resolves them by id", async () => {
      const list = await store.listWorkflowDefinitions();
      expect(list[0].id.startsWith("builtin:")).toBe(true);
      expect(await store.getWorkflowDefinition("builtin:coding")).toBeDefined();
    });

    it("rejects editing or deleting a built-in", async () => {
      await expect(
        store.updateWorkflowDefinition("builtin:coding", { name: "x" }),
      ).rejects.toThrow(/cannot be edited/i);
      await expect(store.deleteWorkflowDefinition("builtin:coding")).rejects.toThrow(/cannot be deleted/i);
    });

    it("a task can select a built-in workflow", async () => {
      const task = await store.createTask({ description: "T", enabledWorkflowSteps: [] });
      await store.selectTaskWorkflow(task.id, "builtin:compound-engineering");
      expect(store.getTaskWorkflowSelection(task.id)?.workflowId).toBe("builtin:compound-engineering");
    });
  });
});
