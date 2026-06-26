import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { BUILTIN_CODING_WORKFLOW_IR } from "../builtin-coding-workflow-ir.js";
import type { TaskStore } from "../store.js";
import type { WorkflowRunStepInstance } from "../types.js";
import type { WorkflowIr } from "../workflow-ir-types.js";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";

/*
FNXC:CustomWorkflows 2026-06-17-10:55:
FN-6580 found no restart evidence for explicit custom-workflow selections, interpreter-deferred built-ins, or their graph/foreach run progress. These tests use the disk-backed store reopen seam instead of booting the engine so restart durability stays fast while proving the store cannot silently switch an in-flight task to a different workflow after process restart.
*/

/*
FNXC:WorkflowStepCRUD 2026-06-26-14:00:
U7c dropped the `workflow_steps` table + the compilation materializer. A selection's
`stepIds` are now the default-on `optional-group` node ids (executor toggle keys), not
materialized step rows. This IR carries one default-on optional-group ("review-group") so
a NON-EMPTY selection's durability across restart is still exercised.
*/
function linearIr(): WorkflowIr {
  return {
    version: "v2",
    name: "restart-linear",
    columns: [{ id: "todo", name: "Todo", traits: [] }],
    nodes: [
      { id: "start", kind: "start", column: "todo" },
      { id: "lint", kind: "gate", column: "todo", config: { name: "Lint", scriptName: "lint" } },
      {
        id: "review-group",
        kind: "optional-group",
        column: "todo",
        config: {
          name: "Review",
          defaultOn: true,
          template: { nodes: [{ id: "review-inner", kind: "prompt", config: { prompt: "verify restart" } }], edges: [] },
        },
      },
      { id: "end", kind: "end", column: "todo" },
    ],
    edges: [
      { from: "start", to: "lint", condition: "success" },
      { from: "lint", to: "review-group", condition: "success" },
      { from: "review-group", to: "end", condition: "success" },
    ],
  };
}

type RestartStore = TaskStore & {
  getTaskWorkflowSelection(taskId: string): { workflowId: string; stepIds: string[] } | undefined;
  selectTaskWorkflow(taskId: string, workflowId: string): Promise<string[]>;
  saveWorkflowRunBranch(state: {
    taskId: string;
    runId: string;
    branchId: string;
    currentNodeId: string;
    status: string;
  }): void;
  loadWorkflowRunBranches(
    taskId: string,
    runId: string,
  ): Array<{ taskId: string; runId: string; branchId: string; currentNodeId: string; status: string }>;
  getBranchProgressByTask(taskIds: readonly string[]): Map<string, Array<{ branchId: string; nodeId: string; status: string }>>;
  saveWorkflowRunStepInstance(state: WorkflowRunStepInstance): void;
  loadWorkflowRunStepInstances(taskId: string, runId: string): WorkflowRunStepInstance[];
};

type PrivateRestartStore = RestartStore & {
  db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } };
  resolveTaskWorkflowIrSync(taskId: string): WorkflowIr;
};

function makeStepInstance(overrides: Partial<WorkflowRunStepInstance> = {}): WorkflowRunStepInstance {
  return {
    taskId: "FN-RESTART",
    runId: "run-restart",
    foreachNodeId: "foreach-steps",
    stepIndex: 0,
    pinnedStepCount: 2,
    currentNodeId: "step-node-a",
    status: "in-progress",
    baselineSha: "abc123",
    checkpointId: "checkpoint-a",
    reworkCount: 1,
    branchName: "fusion/fn-6585-step-0",
    integratedAt: null,
    updatedAt: "2026-06-17T10:55:00.000Z",
    ...overrides,
  };
}

describe("workflow restart durability for explicit selections", () => {
  const harness = createTaskStoreTestHarness();

  beforeEach(async () => {
    await harness.beforeEach();
    await reopenAsDiskBackedStore();
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  async function reopenAsDiskBackedStore(): Promise<void> {
    harness.store().close();
    await harness.reopenDiskBackedStore();
  }

  function store(): RestartStore {
    return harness.store() as RestartStore;
  }

  function privateStore(): PrivateRestartStore {
    return harness.store() as PrivateRestartStore;
  }

  async function taskJsonEnabledWorkflowSteps(taskId: string): Promise<string[] | undefined> {
    const raw = await readFile(join(harness.rootDir(), ".fusion", "tasks", taskId, "task.json"), "utf8");
    const parsed = JSON.parse(raw) as { enabledWorkflowSteps?: unknown };
    return Array.isArray(parsed.enabledWorkflowSteps)
      ? parsed.enabledWorkflowSteps.filter((stepId): stepId is string => typeof stepId === "string")
      : undefined;
  }

  it("keeps the empty no-selection state on the default workflow after restart", async () => {
    const task = await store().createTask({ description: "no explicit workflow", enabledWorkflowSteps: [] });

    await reopenAsDiskBackedStore();

    expect(store().getTaskWorkflowSelection(task.id)).toBeUndefined();
    expect((await store().getTask(task.id)).enabledWorkflowSteps ?? []).toEqual([]);
    expect((await taskJsonEnabledWorkflowSteps(task.id)) ?? []).toEqual([]);
  });

  it("persists explicit custom linear selection, compiled steps, and node/step progress across restart", async () => {
    const workflow = await store().createWorkflowDefinition({ name: "Restart QA", ir: linearIr() });
    const task = await store().createTask({ description: "custom selection", enabledWorkflowSteps: [] });

    const selectedStepIds = await store().selectTaskWorkflow(task.id, workflow.id);
    expect(selectedStepIds).toEqual(["review-group"]);
    store().saveWorkflowRunBranch({
      taskId: task.id,
      runId: "run-restart",
      branchId: "main",
      currentNodeId: "lint",
      status: "running",
    });
    store().saveWorkflowRunBranch({
      taskId: task.id,
      runId: "run-restart",
      branchId: "review",
      currentNodeId: "spec",
      status: "completed",
    });
    store().saveWorkflowRunStepInstance(makeStepInstance({ taskId: task.id, stepIndex: 0 }));
    store().saveWorkflowRunStepInstance(
      makeStepInstance({
        taskId: task.id,
        stepIndex: 1,
        currentNodeId: "step-node-b",
        status: "completed",
        reworkCount: 2,
        branchName: "fusion/fn-6585-step-1",
        integratedAt: "2026-06-17T11:00:00.000Z",
      }),
    );

    await reopenAsDiskBackedStore();

    const selection = store().getTaskWorkflowSelection(task.id);
    expect(selection).toEqual({ workflowId: workflow.id, stepIds: selectedStepIds });
    expect((await store().getTask(task.id)).enabledWorkflowSteps).toEqual(selectedStepIds);
    expect(await taskJsonEnabledWorkflowSteps(task.id)).toEqual(selectedStepIds);

    expect(store().loadWorkflowRunBranches(task.id, "run-restart")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: task.id,
          runId: "run-restart",
          branchId: "main",
          currentNodeId: "lint",
          status: "running",
        }),
        expect.objectContaining({
          taskId: task.id,
          runId: "run-restart",
          branchId: "review",
          currentNodeId: "spec",
          status: "completed",
        }),
      ]),
    );
    expect(store().getBranchProgressByTask([task.id]).get(task.id)).toEqual(
      expect.arrayContaining([
        { branchId: "main", nodeId: "lint", status: "running" },
        { branchId: "review", nodeId: "spec", status: "completed" },
      ]),
    );
    expect(store().loadWorkflowRunStepInstances(task.id, "run-restart")).toEqual([
      expect.objectContaining({
        taskId: task.id,
        runId: "run-restart",
        foreachNodeId: "foreach-steps",
        stepIndex: 0,
        pinnedStepCount: 2,
        currentNodeId: "step-node-a",
        status: "in-progress",
        baselineSha: "abc123",
        checkpointId: "checkpoint-a",
        reworkCount: 1,
        branchName: "fusion/fn-6585-step-0",
        integratedAt: null,
      }),
      expect.objectContaining({
        taskId: task.id,
        runId: "run-restart",
        foreachNodeId: "foreach-steps",
        stepIndex: 1,
        pinnedStepCount: 2,
        currentNodeId: "step-node-b",
        status: "completed",
        baselineSha: "abc123",
        checkpointId: "checkpoint-a",
        reworkCount: 2,
        branchName: "fusion/fn-6585-step-1",
        integratedAt: "2026-06-17T11:00:00.000Z",
      }),
    ]);
  });

  // FNXC:WorkflowStepCRUD 2026-06-26-14:00: U7c — explicit selection of an
  // interpreter-deferred builtin now seeds its DEFAULT-ON optional-group ids (here
  // `code-review`), consistent with the create-time selection path. (The pre-U7c
  // selectTaskWorkflow returned [] for this case — an inconsistency with create-time
  // seeding — because it only returned materialized step ids, which no longer exist.)
  it("persists interpreter-deferred builtin selection seeding its default-on group across restart", async () => {
    const task = await store().createTask({ description: "builtin selection", enabledWorkflowSteps: [] });

    await expect(store().selectTaskWorkflow(task.id, "builtin:coding")).resolves.toEqual(["code-review"]);

    await reopenAsDiskBackedStore();

    expect(store().getTaskWorkflowSelection(task.id)).toEqual({ workflowId: "builtin:coding", stepIds: ["code-review"] });
    expect((await store().getTask(task.id)).enabledWorkflowSteps ?? []).toEqual(["code-review"]);
    expect((await taskJsonEnabledWorkflowSteps(task.id)) ?? []).toEqual(["code-review"]);
    expect(privateStore().resolveTaskWorkflowIrSync(task.id)).toEqual(BUILTIN_CODING_WORKFLOW_IR);
  });

  it("persists create-time workflowId selections for custom and builtin workflows across restart", async () => {
    const workflow = await store().createWorkflowDefinition({ name: "Create-time QA", ir: linearIr() });
    const customTask = await store().createTask({ description: "custom at create", workflowId: workflow.id });
    const builtinTask = await store().createTask({ description: "builtin at create", workflowId: "builtin:coding" });

    const customSelectionBefore = store().getTaskWorkflowSelection(customTask.id);
    expect(customSelectionBefore?.workflowId).toBe(workflow.id);
    expect(customSelectionBefore?.stepIds).toEqual(["review-group"]);
    // FNXC:CodeReviewStep — builtin:coding carries the DEFAULT-ON `code-review`
    // optional-group, so the create-time workflowId path seeds it into the selection.
    expect(store().getTaskWorkflowSelection(builtinTask.id)).toEqual({ workflowId: "builtin:coding", stepIds: ["code-review"] });

    await reopenAsDiskBackedStore();

    const customSelection = store().getTaskWorkflowSelection(customTask.id);
    expect(customSelection).toEqual(customSelectionBefore);
    expect((await store().getTask(customTask.id)).enabledWorkflowSteps).toEqual(customSelectionBefore?.stepIds);
    expect(await taskJsonEnabledWorkflowSteps(customTask.id)).toEqual(customSelectionBefore?.stepIds);
    expect(store().getTaskWorkflowSelection(builtinTask.id)).toEqual({ workflowId: "builtin:coding", stepIds: ["code-review"] });
    expect((await store().getTask(builtinTask.id)).enabledWorkflowSteps ?? []).toEqual(["code-review"]);
    expect((await taskJsonEnabledWorkflowSteps(builtinTask.id)) ?? []).toEqual(["code-review"]);
  });

  it("fails closed when a selected custom workflow definition is missing without corrupting the dangling selection", async () => {
    const workflow = await store().createWorkflowDefinition({ name: "Dangling QA", ir: linearIr() });
    const selectedTask = await store().createTask({ description: "dangling custom", workflowId: workflow.id });
    const untouchedTask = await store().createTask({ description: "select missing later", enabledWorkflowSteps: [] });
    const selectionBefore = store().getTaskWorkflowSelection(selectedTask.id);
    const enabledBefore = await taskJsonEnabledWorkflowSteps(selectedTask.id);
    const taskCountBefore = (await store().listTasks({ includeArchived: true })).length;

    privateStore().db.prepare("DELETE FROM workflows WHERE id = ?").run(workflow.id);

    await reopenAsDiskBackedStore();

    expect(store().getTaskWorkflowSelection(selectedTask.id)).toEqual(selectionBefore);
    expect(await taskJsonEnabledWorkflowSteps(selectedTask.id)).toEqual(enabledBefore);
    // Current hot-path resolution degrades a dangling custom definition to the built-in IR instead of throwing.
    // The explicit materialization APIs below must still fail closed when asked to write that missing id again.
    expect(privateStore().resolveTaskWorkflowIrSync(selectedTask.id)).toEqual(BUILTIN_CODING_WORKFLOW_IR);

    await expect(store().selectTaskWorkflow(untouchedTask.id, workflow.id)).rejects.toThrow(
      `Workflow '${workflow.id}' not found`,
    );
    await expect(store().createTask({ description: "create missing", workflowId: workflow.id })).rejects.toThrow(
      `Workflow '${workflow.id}' not found`,
    );

    expect(store().getTaskWorkflowSelection(selectedTask.id)).toEqual(selectionBefore);
    expect(await taskJsonEnabledWorkflowSteps(selectedTask.id)).toEqual(enabledBefore);
    expect(store().getTaskWorkflowSelection(untouchedTask.id)).toBeUndefined();
    expect((await store().getTask(untouchedTask.id)).enabledWorkflowSteps ?? []).toEqual([]);
    expect((await store().listTasks({ includeArchived: true })).length).toBe(taskCountBefore);
  });
});
