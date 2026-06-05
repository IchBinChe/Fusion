import { describe, it, expect } from "vitest";
import {
  createWorkflowAuthoringTools,
  createWorkflowListTool,
  createWorkflowGetTool,
  createWorkflowSelectTool,
  createWorkflowCreateTool,
  createWorkflowUpdateTool,
  createWorkflowDeleteTool,
} from "../index.js";
import type { TaskStore } from "@fusion/core";

/**
 * U11 / R12 drift guard (engine half): the workflow-authoring tool surface that
 * chat, planning, and the task executor all share must always expose the six
 * `fn_workflow_*` tools. The lanes assemble their toolset from
 * `createWorkflowAuthoringTools` (chat/planning) and the executor mirrors the
 * same factories — so asserting factory completeness here guards every lane's
 * source of truth. Lane-wiring (that chat/planning actually pass these to
 * createFnAgent) is asserted in packages/dashboard's exposure test.
 *
 * We invoke the REAL factories with a fake store — never mock the factories
 * themselves — so a renamed/removed tool name is caught.
 */

const REQUIRED_WORKFLOW_TOOLS = [
  "fn_workflow_create",
  "fn_workflow_update",
  "fn_workflow_delete",
  "fn_workflow_list",
  "fn_workflow_get",
  "fn_workflow_select",
] as const;

// Minimal stand-in; the factories only capture the store reference at build
// time, so no methods are exercised by name-membership assertions.
const fakeStore = {} as unknown as TaskStore;

describe("workflow tool exposure (engine factories)", () => {
  it("createWorkflowAuthoringTools exposes all six fn_workflow_* tools plus fn_trait_list", () => {
    const names = createWorkflowAuthoringTools(fakeStore, "FN-1").map((t) => t.name);
    for (const required of REQUIRED_WORKFLOW_TOOLS) {
      expect(names).toContain(required);
    }
    expect(names).toContain("fn_trait_list");
  });

  it("each fn_workflow_* factory produces a tool with the expected name", () => {
    expect(createWorkflowListTool(fakeStore).name).toBe("fn_workflow_list");
    expect(createWorkflowGetTool(fakeStore).name).toBe("fn_workflow_get");
    expect(createWorkflowSelectTool(fakeStore, "FN-1").name).toBe("fn_workflow_select");
    expect(createWorkflowCreateTool(fakeStore).name).toBe("fn_workflow_create");
    expect(createWorkflowUpdateTool(fakeStore).name).toBe("fn_workflow_update");
    expect(createWorkflowDeleteTool(fakeStore).name).toBe("fn_workflow_delete");
  });
});
