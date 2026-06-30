import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { WorkflowCompileError } from "../workflow-compiler.js";
import type { WorkflowIr } from "../workflow-ir-types.js";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";

/*
FNXC:CustomWorkflows 2026-06-18-12:00:
FN-6643 hardened the create-time workflow selection invariant: every task creation entry point that shares materializeExplicitWorkflowSteps must fail closed for unknown explicit workflow ids before creating a task row or task_workflow_selection state.
*/

/** Linear workflow with two pre-merge steps. */
function linearIr(): WorkflowIr {
  return {
    version: "v1",
    name: "wf",
    nodes: [
      { id: "start", kind: "start" },
      { id: "lint", kind: "gate", config: { name: "Lint", scriptName: "lint" } },
      { id: "spec", kind: "prompt", config: { name: "Spec", prompt: "check" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "lint", condition: "success" },
      { from: "lint", to: "spec", condition: "success" },
      { from: "spec", to: "end", condition: "success" },
    ],
  };
}

/** A single-node fragment IR (start → one node → end). */
function fragmentIr(): WorkflowIr {
  return {
    version: "v1",
    name: "frag",
    nodes: [
      { id: "start", kind: "start" },
      { id: "step-1", kind: "prompt", config: { name: "Doc", prompt: "doc it" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "step-1", condition: "success" },
      { from: "step-1", to: "end", condition: "success" },
    ],
  };
}

function branchingIr(): WorkflowIr {
  return {
    version: "v1",
    name: "branchy",
    nodes: [
      { id: "start", kind: "start" },
      { id: "a", kind: "prompt", config: { prompt: "a" } },
      { id: "b", kind: "prompt", config: { prompt: "b" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "a", condition: "success" },
      { from: "a", to: "b", condition: "success" },
      { from: "a", to: "end", condition: "success" },
      { from: "b", to: "end", condition: "success" },
    ],
  };
}

/*
FNXC:WorkflowStepCRUD 2026-06-26-14:00:
U7c dropped the `workflow_steps` table and the workflow-compilation materializer.
Selecting/inheriting a workflow no longer materializes per-step rows: the graph runs the
selected workflow's IR directly, and `task.enabledWorkflowSteps` / `selection.stepIds` now
hold ONLY the ids of default-on `optional-group` nodes (the executor toggle keys). A pure
v1 linear workflow has no optional-group nodes, so its selection seeds an EMPTY set. The
invariant `selection.stepIds === task.enabledWorkflowSteps` still holds.
*/
/** v2 workflow whose success path threads through two optional-group nodes
 *  (og-on defaultOn:true, og-off defaultOn:false). */
function optionalGroupIr(options: { onId?: string; offId?: string; name?: string } = {}): WorkflowIr {
  const onId = options.onId ?? "og-on";
  const offId = options.offId ?? "og-off";
  const groupTemplate = (id: string) => ({
    nodes: [{ id: `${id}-inner`, kind: "prompt" as const, config: { prompt: "x" } }],
    edges: [],
  });
  return {
    version: "v2",
    name: options.name ?? "og-wf",
    columns: [{ id: "todo", name: "Todo", traits: [] }],
    nodes: [
      { id: "start", kind: "start", column: "todo" },
      {
        id: onId,
        kind: "optional-group",
        column: "todo",
        config: { name: "On Group", defaultOn: true, template: groupTemplate(onId) },
      },
      {
        id: offId,
        kind: "optional-group",
        column: "todo",
        config: { name: "Off Group", defaultOn: false, template: groupTemplate(offId) },
      },
      { id: "end", kind: "end", column: "todo" },
    ],
    edges: [
      { from: "start", to: onId, condition: "success" },
      { from: onId, to: offId, condition: "success" },
      { from: offId, to: "end", condition: "success" },
    ],
  };
}

function nonTriageIntakeIr(): WorkflowIr {
  const ir = optionalGroupIr({ name: "non-triage-intake" }) as Extract<WorkflowIr, { version: "v2" }>;
  return {
    ...ir,
    columns: [{ id: "intake", name: "Intake", traits: [{ trait: "intake" }] }],
    nodes: ir.nodes.map((node) => ({ ...node, column: "intake" })),
  };
}

describe("TaskStore workflow selection (U3)", () => {
  const harness = createTaskStoreTestHarness();
  let store: ReturnType<typeof harness.store>;

  beforeEach(async () => {
    await harness.beforeEach();
    store = harness.store();
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  it("selecting a workflow seeds enabledWorkflowSteps with default-on group ids and records selection", async () => {
    const wf = await store.createWorkflowDefinition({ name: "QA", ir: optionalGroupIr() });
    const task = await store.createTask({ description: "T", enabledWorkflowSteps: [] });

    await store.selectTaskWorkflow(task.id, wf.id);

    const detail = await store.getTask(task.id);
    // Only the defaultOn:true optional-group id is seeded (og-off is excluded).
    expect(detail.enabledWorkflowSteps).toEqual(["og-on"]);
    const selection = store.getTaskWorkflowSelection(task.id);
    expect(selection?.workflowId).toBe(wf.id);
    expect(selection?.stepIds).toEqual(detail.enabledWorkflowSteps);
  });

  it("selecting a pure-linear workflow records the selection with an empty step set", async () => {
    const wf = await store.createWorkflowDefinition({ name: "QA", ir: linearIr() });
    const task = await store.createTask({ description: "T", enabledWorkflowSteps: [] });

    await store.selectTaskWorkflow(task.id, wf.id);

    const detail = await store.getTask(task.id);
    // No optional-group nodes → no toggle ids; the graph runs the IR's nodes directly.
    expect(detail.enabledWorkflowSteps ?? []).toEqual([]);
    const selection = store.getTaskWorkflowSelection(task.id);
    expect(selection?.workflowId).toBe(wf.id);
    expect(selection?.stepIds).toEqual(detail.enabledWorkflowSteps ?? []);
    // U7c: the legacy step manager listing is gone; the table-backed list is empty.
    expect(await store.listWorkflowSteps()).toHaveLength(0);
  });

  it("re-selecting replaces the prior selection's seeded group ids", async () => {
    const wfA = await store.createWorkflowDefinition({ name: "A", ir: optionalGroupIr() });
    const wfB = await store.createWorkflowDefinition({ name: "B", ir: linearIr() });
    const task = await store.createTask({ description: "T", enabledWorkflowSteps: [] });

    await store.selectTaskWorkflow(task.id, wfA.id);
    expect(store.getTaskWorkflowSelection(task.id)!.stepIds).toEqual(["og-on"]);

    await store.selectTaskWorkflow(task.id, wfB.id);
    const secondIds = store.getTaskWorkflowSelection(task.id)!.stepIds;
    // The prior selection's group ids are replaced wholesale by the new workflow's.
    expect(secondIds).toEqual([]);
    const detail = await store.getTask(task.id);
    expect(detail.enabledWorkflowSteps ?? []).toEqual(secondIds);
    expect(store.getTaskWorkflowSelection(task.id)!.workflowId).toBe(wfB.id);
  });

  it("clearing selection empties enabledWorkflowSteps", async () => {
    const wf = await store.createWorkflowDefinition({ name: "QA", ir: optionalGroupIr() });
    const task = await store.createTask({ description: "T", enabledWorkflowSteps: [] });
    await store.selectTaskWorkflow(task.id, wf.id);
    expect((await store.getTask(task.id)).enabledWorkflowSteps).toEqual(["og-on"]);

    await store.clearTaskWorkflowSelection(task.id);
    const detail = await store.getTask(task.id);
    expect(detail.enabledWorkflowSteps ?? []).toHaveLength(0);
    expect(store.getTaskWorkflowSelection(task.id)).toBeUndefined();
  });

  it("rejects selecting a non-linear workflow without writing partial state", async () => {
    const wf = await store.createWorkflowDefinition({ name: "Branchy", ir: branchingIr() });
    const task = await store.createTask({ description: "T", enabledWorkflowSteps: [] });

    await expect(store.selectTaskWorkflow(task.id, wf.id)).rejects.toBeInstanceOf(WorkflowCompileError);
    expect(store.getTaskWorkflowSelection(task.id)).toBeUndefined();
    const detail = await store.getTask(task.id);
    expect(detail.enabledWorkflowSteps ?? []).toHaveLength(0);
  });

  it("force-resurrecting over a tombstoned task purges its prior workflow selection", async () => {
    const wf = await store.createWorkflowDefinition({ name: "QA", ir: optionalGroupIr() });
    const task = await store.createTask({ description: "T", enabledWorkflowSteps: [] });
    await store.selectTaskWorkflow(task.id, wf.id);
    expect(store.getTaskWorkflowSelection(task.id)!.stepIds).toEqual(["og-on"]);

    // Soft-delete then physically resurrect the same id; the physical purge of
    // the old tasks row must drop the orphaned selection row (U7c: no compiled
    // step rows to reclaim — selection ids are optional-group node ids).
    await store.deleteTask(task.id);
    await store.createTaskWithReservedId(
      { description: "resurrected", enabledWorkflowSteps: [], forceResurrect: true },
      { taskId: task.id, applyDefaultWorkflowSteps: false },
    );

    expect(store.getTaskWorkflowSelection(task.id)).toBeUndefined();
  });

  it("throws when selecting an unknown workflow", async () => {
    const task = await store.createTask({ description: "T", enabledWorkflowSteps: [] });
    await expect(store.selectTaskWorkflow(task.id, "WF-404")).rejects.toThrow(/not found/i);
  });

  it("new tasks inherit the project default workflow", async () => {
    const wf = await store.createWorkflowDefinition({ name: "Default", ir: optionalGroupIr() });
    await store.setDefaultWorkflowId(wf.id);

    const task = await store.createTask({ description: "inherits" });
    const detail = await store.getTask(task.id);
    // Inherits the default workflow's default-on optional-group seed.
    expect(detail.enabledWorkflowSteps).toEqual(["og-on"]);
    expect(store.getTaskWorkflowSelection(task.id)?.workflowId).toBe(wf.id);
  });

  // FNXC:WorkflowOptionalGroup 2026-06-21-14:30: a new task seeds
  // `enabledWorkflowSteps` with exactly the defaultOn:true optional-group ids of
  // its selected workflow (U3, R3). (U7c: these are the ONLY seeded ids — there
  // are no compiled workflow step ids anymore.)
  describe("optional-group defaultOn seeding (U3/R3)", () => {
    it("seeds the defaultOn:true group id at creation from the default workflow", async () => {
      const wf = await store.createWorkflowDefinition({ name: "OG Default", ir: optionalGroupIr() });
      await store.setDefaultWorkflowId(wf.id);

      const task = await store.createTask({ description: "seeded" });
      const detail = await store.getTask(task.id);
      expect(detail.enabledWorkflowSteps).toContain("og-on");
      expect(detail.enabledWorkflowSteps).not.toContain("og-off");
    });

    it("seeds an empty set when the workflow has no optional groups", async () => {
      const wf = await store.createWorkflowDefinition({ name: "No OG", ir: linearIr() });
      await store.setDefaultWorkflowId(wf.id);

      const task = await store.createTask({ description: "no groups" });
      const detail = await store.getTask(task.id);
      expect(detail.enabledWorkflowSteps ?? []).not.toContain("og-on");
    });

    it("a stale optional-group id in enabledWorkflowSteps does not crash resolution", async () => {
      // Group since removed from the workflow: the toggle resolver ignores the
      // stale id rather than throwing, keeping create/edit surfaces alive.
      const task = await store.createTask({
        description: "stale",
        enabledWorkflowSteps: ["og-removed"],
      });
      const detail = await store.getTask(task.id);
      expect(detail.enabledWorkflowSteps).toContain("og-removed");
    });

    // FNXC:WorkflowOptionalGroup 2026-06-21-16:30: code-review P1 regression. A
    // built-in optional-group id deliberately equals a WORKFLOW_STEP_TEMPLATES id
    // (the browser-verification migration). Enabling it on a task must keep the
    // RAW group node id in enabledWorkflowSteps — not a materialized WorkflowStep
    // row id — or the executor's `enabledWorkflowSteps.includes(node.id)` check
    // silently bypasses the group. (The og-on/og-off ids above don't collide, so
    // only a colliding id exercises the remap bug.)
    function collidingGroupIr(): WorkflowIr {
      return {
        version: "v2",
        name: "bv-wf",
        columns: [{ id: "todo", name: "Todo", traits: [] }],
        nodes: [
          { id: "start", kind: "start", column: "todo" },
          {
            id: "browser-verification",
            kind: "optional-group",
            column: "todo",
            config: {
              name: "Browser Verification",
              defaultOn: false,
              template: { nodes: [{ id: "bv-inner", kind: "prompt", config: { prompt: "verify" } }], edges: [] },
            },
          },
          { id: "end", kind: "end", column: "todo" },
        ],
        edges: [
          { from: "start", to: "browser-verification", condition: "success" },
          { from: "browser-verification", to: "end", condition: "success" },
        ],
      };
    }

    it("keeps a built-in-colliding optional-group id unremapped on create-with-enable", async () => {
      const wf = await store.createWorkflowDefinition({ name: "BV", ir: collidingGroupIr() });
      await store.setDefaultWorkflowId(wf.id);

      const task = await store.createTask({
        description: "enable bv",
        enabledWorkflowSteps: ["browser-verification"],
      });
      const detail = await store.getTask(task.id);
      expect(detail.enabledWorkflowSteps).toContain("browser-verification");
    });

    it("keeps a built-in-colliding optional-group id unremapped on update/toggle", async () => {
      const wf = await store.createWorkflowDefinition({ name: "BV", ir: collidingGroupIr() });
      await store.setDefaultWorkflowId(wf.id);

      const task = await store.createTask({ description: "toggle bv" });
      await store.updateTask(task.id, { enabledWorkflowSteps: ["browser-verification"] });
      const detail = await store.getTask(task.id);
      expect(detail.enabledWorkflowSteps).toContain("browser-verification");
    });
  });

  it("explicit enabledWorkflowSteps overrides the project default", async () => {
    const wf = await store.createWorkflowDefinition({ name: "Default", ir: linearIr() });
    await store.setDefaultWorkflowId(wf.id);

    const task = await store.createTask({ description: "override", enabledWorkflowSteps: [] });
    const detail = await store.getTask(task.id);
    expect(detail.enabledWorkflowSteps ?? []).toHaveLength(0);
    expect(store.getTaskWorkflowSelection(task.id)).toBeUndefined();
  });

  it("setDefaultWorkflowId rejects an unknown workflow and clears with null", async () => {
    await expect(store.setDefaultWorkflowId("WF-404")).rejects.toThrow(/not found/i);
    const wf = await store.createWorkflowDefinition({ name: "D", ir: linearIr() });
    await store.setDefaultWorkflowId(wf.id);
    expect(await store.getDefaultWorkflowId()).toBe(wf.id);
    await store.setDefaultWorkflowId(null);
    expect(await store.getDefaultWorkflowId()).toBeUndefined();
  });

  async function moveToDone(taskId: string): Promise<void> {
    await store.moveTask(taskId, "todo");
    await store.moveTask(taskId, "in-progress");
    await store.moveTask(taskId, "in-review");
    await store.moveTask(taskId, "done");
  }

  describe("refinement workflow inheritance (FN-7265)", () => {
    it("preserves a custom workflow selection by reseeding its default-on optional groups", async () => {
      const wf = await store.createWorkflowDefinition({ name: "QA", ir: optionalGroupIr() });
      const otherWorkflow = await store.createWorkflowDefinition({
        name: "Other QA",
        ir: optionalGroupIr({ onId: "other-on", offId: "other-off", name: "other-og-wf" }),
      });
      const source = await store.createTask({ description: "source", enabledWorkflowSteps: [] });
      await store.selectTaskWorkflow(source.id, otherWorkflow.id);
      await store.selectTaskWorkflow(source.id, wf.id);
      await store.updateTask(source.id, { enabledWorkflowSteps: ["other-on", "stale-manual-toggle"] });
      await moveToDone(source.id);

      const refined = await store.refineTask(source.id, "follow up");
      const detail = await store.getTask(refined.id);
      const refinedSelection = store.getTaskWorkflowSelection(refined.id);

      expect(refinedSelection?.workflowId).toBe(wf.id);
      expect(refinedSelection?.stepIds).toEqual(["og-on"]);
      expect(detail.enabledWorkflowSteps).toEqual(["og-on"]);
      expect(detail.enabledWorkflowSteps).not.toEqual(["other-on", "stale-manual-toggle"]);
      expect(detail.enabledWorkflowSteps).not.toContain("other-on");
    });

    it("places a custom-workflow refinement in its non-triage entry column", async () => {
      const wf = await store.createWorkflowDefinition({ name: "Non-triage QA", ir: nonTriageIntakeIr() });
      const source = await store.createTask({ description: "source", enabledWorkflowSteps: [] });
      await store.selectTaskWorkflow(source.id, wf.id);
      await moveToDone(source.id);

      const refined = await store.refineTask(source.id, "follow up");
      const detail = await store.getTask(refined.id);

      expect(store.getTaskWorkflowSelection(refined.id)).toEqual({ workflowId: wf.id, stepIds: ["og-on"] });
      expect(detail.column).toBe("intake");
      expect(detail.column).not.toBe("triage");
    });

    it("preserves a custom workflow selection with an empty optional-group seed set", async () => {
      const wf = await store.createWorkflowDefinition({ name: "Linear", ir: linearIr() });
      const source = await store.createTask({ description: "source", enabledWorkflowSteps: [] });
      await store.selectTaskWorkflow(source.id, wf.id);
      await moveToDone(source.id);

      const refined = await store.refineTask(source.id, "follow up");

      expect(store.getTaskWorkflowSelection(refined.id)).toEqual({ workflowId: wf.id, stepIds: [] });
      expect((await store.getTask(refined.id)).enabledWorkflowSteps ?? []).toEqual([]);
    });

    it("preserves a non-default built-in workflow selection", async () => {
      const source = await store.createTask({ description: "source", enabledWorkflowSteps: [] });
      await store.selectTaskWorkflow(source.id, "builtin:quick-fix");
      await moveToDone(source.id);

      const refined = await store.refineTask(source.id, "follow up");

      expect(store.getTaskWorkflowSelection(refined.id)?.workflowId).toBe("builtin:quick-fix");
    });

    it("uses normal default-workflow inheritance when the source has no explicit selection", async () => {
      const defaultWorkflow = await store.createWorkflowDefinition({ name: "Default", ir: optionalGroupIr() });
      await store.setDefaultWorkflowId(defaultWorkflow.id);
      const source = await store.createTask({ description: "source", enabledWorkflowSteps: [] });
      expect(store.getTaskWorkflowSelection(source.id)).toBeUndefined();
      await moveToDone(source.id);

      const refined = await store.refineTask(source.id, "follow up");

      const detail = await store.getTask(refined.id);
      expect(store.getTaskWorkflowSelection(refined.id)).toEqual({ workflowId: defaultWorkflow.id, stepIds: ["og-on"] });
      expect(detail.enabledWorkflowSteps).toEqual(["og-on"]);
      expect(detail.column).toBe("todo");
    });

    it("does not create an explicit selection row for no-selection sources without a default workflow", async () => {
      const source = await store.createTask({ description: "source", enabledWorkflowSteps: [] });
      expect(store.getTaskWorkflowSelection(source.id)).toBeUndefined();
      await moveToDone(source.id);

      const refined = await store.refineTask(source.id, "follow up");

      expect(store.getTaskWorkflowSelection(refined.id)).toBeUndefined();
      expect((await store.getTask(refined.id)).enabledWorkflowSteps ?? []).toEqual([]);
    });

    it("falls back to the default workflow when the source selection row is stale", async () => {
      const defaultWorkflow = await store.createWorkflowDefinition({ name: "Default", ir: optionalGroupIr() });
      await store.setDefaultWorkflowId(defaultWorkflow.id);
      const source = await store.createTask({ description: "source", enabledWorkflowSteps: [] });
      store.getDatabase().prepare(
        `INSERT INTO task_workflow_selection (taskId, workflowId, stepIds, updatedAt)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(taskId) DO UPDATE SET workflowId = excluded.workflowId, stepIds = excluded.stepIds, updatedAt = excluded.updatedAt`,
      ).run(source.id, "WF-MISSING", JSON.stringify(["stale-group"]), new Date().toISOString());
      await moveToDone(source.id);
      const before = (await store.listTasks({ includeArchived: true })).length;

      const refined = await store.refineTask(source.id, "follow up");

      const detail = await store.getTask(refined.id);
      expect((await store.listTasks({ includeArchived: true })).length).toBe(before + 1);
      expect(store.getTaskWorkflowSelection(refined.id)).toEqual({ workflowId: defaultWorkflow.id, stepIds: ["og-on"] });
      expect(detail.column).toBe("todo");
    });

    it("fails before creating a refinement when the explicit source workflow cannot materialize", async () => {
      const invalidWorkflow = await store.createWorkflowDefinition({ name: "Branchy", ir: branchingIr() });
      const source = await store.createTask({ description: "source", enabledWorkflowSteps: [] });
      store.getDatabase().prepare(
        `INSERT INTO task_workflow_selection (taskId, workflowId, stepIds, updatedAt)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(taskId) DO UPDATE SET workflowId = excluded.workflowId, stepIds = excluded.stepIds, updatedAt = excluded.updatedAt`,
      ).run(source.id, invalidWorkflow.id, JSON.stringify([]), new Date().toISOString());
      await moveToDone(source.id);
      const before = (await store.listTasks({ includeArchived: true })).length;

      await expect(store.refineTask(source.id, "follow up")).rejects.toBeInstanceOf(WorkflowCompileError);

      expect((await store.listTasks({ includeArchived: true })).length).toBe(before);
    });
  });

  // U6/R3/KTD-4: create-time `workflowId` materializes the selection atomically.
  describe("create-time workflowId (U6/R3)", () => {
    it("seeds enabledWorkflowSteps atomically when workflowId is given", async () => {
      const wf = await store.createWorkflowDefinition({ name: "Pick", ir: optionalGroupIr() });

      const task = await store.createTask({ description: "with workflow", workflowId: wf.id });
      // Reading the task right after create observes the populated group seed — no
      // intermediate empty state visible to the executor.
      const detail = await store.getTask(task.id);
      expect(detail.enabledWorkflowSteps).toEqual(["og-on"]);
      expect(store.getTaskWorkflowSelection(task.id)?.workflowId).toBe(wf.id);
      expect(store.getTaskWorkflowSelection(task.id)?.stepIds).toEqual(detail.enabledWorkflowSteps);
    });

    it("explicit workflowId overrides the project default", async () => {
      const def = await store.createWorkflowDefinition({ name: "Default", ir: linearIr() });
      const chosen = await store.createWorkflowDefinition({ name: "Chosen", ir: linearIr() });
      await store.setDefaultWorkflowId(def.id);

      const task = await store.createTask({ description: "override default", workflowId: chosen.id });
      expect(store.getTaskWorkflowSelection(task.id)?.workflowId).toBe(chosen.id);
    });

    it("workflowId: null skips default materialization (explicit No workflow)", async () => {
      const def = await store.createWorkflowDefinition({ name: "Default", ir: linearIr() });
      await store.setDefaultWorkflowId(def.id);

      const task = await store.createTask({ description: "no workflow", workflowId: null });
      const detail = await store.getTask(task.id);
      expect(detail.enabledWorkflowSteps ?? []).toHaveLength(0);
      expect(store.getTaskWorkflowSelection(task.id)).toBeUndefined();
    });

    it("undefined workflowId still inherits the project default (unchanged)", async () => {
      const def = await store.createWorkflowDefinition({ name: "Default", ir: optionalGroupIr() });
      await store.setDefaultWorkflowId(def.id);

      const task = await store.createTask({ description: "inherit" });
      const detail = await store.getTask(task.id);
      expect(detail.enabledWorkflowSteps).toEqual(["og-on"]);
      expect(store.getTaskWorkflowSelection(task.id)?.workflowId).toBe(def.id);
    });

    it("rejects a fragment id before creating the task row", async () => {
      const frag = await store.createWorkflowDefinition({ name: "Frag", ir: fragmentIr(), kind: "fragment" });
      const before = (await store.listTasks({ includeArchived: true })).length;

      await expect(
        store.createTask({ description: "frag pick", workflowId: frag.id }),
      ).rejects.toThrow(/fragment/i);

      const after = (await store.listTasks({ includeArchived: true })).length;
      expect(after).toBe(before);
    });

    it("rejects an unknown workflow id before creating a task row across create entry points", async () => {
      const beforeCreateTask = (await store.listTasks({ includeArchived: true })).length;

      await expect(
        store.createTask({ description: "bad pick", workflowId: "WF-404" }),
      ).rejects.toThrow(/not found/i);

      const afterCreateTask = (await store.listTasks({ includeArchived: true })).length;
      expect(afterCreateTask).toBe(beforeCreateTask);

      const reservedTaskId = "FN-RESERVED-404";
      const beforeReservedCreate = (await store.listTasks({ includeArchived: true })).length;

      await expect(
        store.createTaskWithReservedId(
          { description: "bad reserved pick", workflowId: "WF-404" },
          { taskId: reservedTaskId, applyDefaultWorkflowSteps: true },
        ),
      ).rejects.toThrow(/not found/i);

      const afterReservedCreate = (await store.listTasks({ includeArchived: true })).length;
      expect(afterReservedCreate).toBe(beforeReservedCreate);
      expect(store.getTaskWorkflowSelection(reservedTaskId)).toBeUndefined();
    });
  });
});
