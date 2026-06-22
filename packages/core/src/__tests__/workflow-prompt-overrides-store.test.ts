import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { createTaskStoreTestHarness } from "./store-test-helpers.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../builtin-coding-workflow-ir.js";
import { getBuiltinWorkflow } from "../builtin-workflows.js";
import { resolveSeamPromptFromIr, resolveWorkflowIrById, resolveWorkflowIrForTask } from "../workflow-ir-resolver.js";
import type { WorkflowIr } from "../workflow-ir-types.js";

function makeIr(): WorkflowIr {
  return {
    version: "v1",
    name: "prompt-overrides-test",
    nodes: [
      { id: "start", kind: "start" },
      { id: "lint", kind: "gate", config: { prompt: "Run lint" } },
      { id: "review", kind: "prompt", config: { prompt: "Review carefully" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "lint" },
      { from: "lint", to: "review" },
      { from: "review", to: "end" },
    ],
  };
}

describe("TaskStore workflow prompt overrides", () => {
  const harness = createTaskStoreTestHarness();

  beforeEach(harness.beforeEach);
  afterEach(harness.afterEach);

  it("returns an empty map when no override row exists", () => {
    const store = harness.store();
    expect(store.getWorkflowPromptOverrides("builtin:coding", store.getWorkflowSettingsProjectId())).toEqual({});
  });

  it("upserts and merges prompt override maps by workflow and project", async () => {
    const store = harness.store();
    const workflow = await store.createWorkflowDefinition({ name: "Promptable", ir: makeIr() });
    const projectId = store.getWorkflowSettingsProjectId();

    expect(store.updateWorkflowPromptOverrides(workflow.id, projectId, { lint: "Run a stricter lint" })).toEqual({
      lint: "Run a stricter lint",
    });
    expect(store.updateWorkflowPromptOverrides(workflow.id, projectId, { review: "Review with context" })).toEqual({
      lint: "Run a stricter lint",
      review: "Review with context",
    });
    expect(store.getWorkflowPromptOverrides(workflow.id, projectId)).toEqual({
      lint: "Run a stricter lint",
      review: "Review with context",
    });
  });

  it("treats null, empty, and whitespace values as reset-to-default deletes", async () => {
    const store = harness.store();
    const workflow = await store.createWorkflowDefinition({ name: "Promptable", ir: makeIr() });
    const projectId = store.getWorkflowSettingsProjectId();

    store.updateWorkflowPromptOverrides(workflow.id, projectId, {
      lint: "Run a stricter lint",
      review: "Review with context",
      extra: "Extra prompt",
    });

    expect(
      store.updateWorkflowPromptOverrides(workflow.id, projectId, {
        lint: null,
        review: "",
        extra: "   ",
      }),
    ).toEqual({});
    expect(store.getWorkflowPromptOverrides(workflow.id, projectId)).toEqual({});
  });

  it("enumerates stored prompt overrides for the current project", async () => {
    const store = harness.store();
    const first = await store.createWorkflowDefinition({ name: "First", ir: makeIr() });
    const second = await store.createWorkflowDefinition({ name: "Second", ir: makeIr() });
    const projectId = store.getWorkflowSettingsProjectId();

    store.updateWorkflowPromptOverrides(first.id, projectId, { lint: "First lint" });
    store.updateWorkflowPromptOverrides(second.id, projectId, { review: "Second review" });

    expect(store.listWorkflowPromptOverridesForProject()).toMatchObject({
      [first.id]: { lint: "First lint" },
      [second.id]: { review: "Second review" },
    });
  });

  it("cascades prompt override rows when a custom workflow is deleted", async () => {
    const store = harness.store();
    const workflow = await store.createWorkflowDefinition({ name: "Temporary", ir: makeIr() });
    const projectId = store.getWorkflowSettingsProjectId();

    store.updateWorkflowPromptOverrides(workflow.id, projectId, { lint: "Temporary override" });
    await store.deleteWorkflowDefinition(workflow.id);

    expect(store.getWorkflowPromptOverrides(workflow.id, projectId)).toEqual({});
    expect(store.listWorkflowPromptOverridesForProject()[workflow.id]).toBeUndefined();
  });

  it("overlays built-in prompt overrides in getWorkflowDefinition without mutating the shared IR", async () => {
    const store = harness.store();
    const projectId = store.getWorkflowSettingsProjectId();
    const before = JSON.stringify(BUILTIN_CODING_WORKFLOW_IR);

    store.updateWorkflowPromptOverrides("builtin:coding", projectId, { execute: "Execute from store override" });

    const def = await store.getWorkflowDefinition("builtin:coding");
    expect(def?.ir.nodes.find((node) => node.id === "execute")?.config?.prompt).toBe("Execute from store override");
    expect(JSON.stringify(BUILTIN_CODING_WORKFLOW_IR)).toBe(before);
  });

  it("overlays sync task IR resolution for default and explicitly selected built-ins", async () => {
    const store = harness.store();
    const projectId = store.getWorkflowSettingsProjectId();
    store.updateWorkflowPromptOverrides("builtin:coding", projectId, { execute: "Execute sync override" });
    store.updateWorkflowPromptOverrides("builtin:review-heavy", projectId, { security: "Security sync override" });

    const defaultTask = await store.createTask({ description: "uses default", workflowId: null });
    const explicitTask = await store.createTask({ description: "uses review heavy", workflowId: "builtin:review-heavy" });

    const resolveSync = store as unknown as { resolveTaskWorkflowIrSync(taskId: string): WorkflowIr };
    expect(resolveSeamPromptFromIr(resolveSync.resolveTaskWorkflowIrSync(defaultTask.id), "execute")).toBe("Execute sync override");
    expect(resolveSync.resolveTaskWorkflowIrSync(explicitTask.id).nodes.find((node) => node.id === "security")?.config?.prompt).toBe(
      "Security sync override",
    );
  });

  it("overlays public workflow IR resolver paths with project-scoped built-in overrides", async () => {
    const store = harness.store();
    const projectId = store.getWorkflowSettingsProjectId();
    store.updateWorkflowPromptOverrides("builtin:coding", projectId, { execute: "Execute resolver override" });

    const task = await store.createTask({ description: "resolver default", workflowId: null });

    expect(resolveSeamPromptFromIr(await resolveWorkflowIrById(store, "builtin:coding"), "execute")).toBe(
      "Execute resolver override",
    );
    expect(resolveSeamPromptFromIr(await resolveWorkflowIrForTask(store, task.id), "execute")).toBe(
      "Execute resolver override",
    );
  });

  it("materializes built-in non-seam prompt and gate overrides into WorkflowStep rows", async () => {
    const store = harness.store();
    const projectId = store.getWorkflowSettingsProjectId();
    store.updateWorkflowPromptOverrides("builtin:review-heavy", projectId, { security: "Security materialized override" });
    store.updateWorkflowPromptOverrides("builtin:compound-engineering", projectId, { plan: "Plan materialized override" });

    const reviewTask = await store.createTask({ description: "review heavy", workflowId: "builtin:review-heavy" });
    const reviewSteps = await Promise.all((reviewTask.enabledWorkflowSteps ?? []).map((id) => store.getWorkflowStep(id)));
    expect(reviewSteps.find((step) => step?.name === "Security review")?.prompt).toBe("Security materialized override");

    const ceIr = getBuiltinWorkflow("builtin:compound-engineering")!.ir;
    const originalPlan = ceIr.nodes.find((node) => node.id === "plan")?.config?.prompt;
    const ceDef = await store.getWorkflowDefinition("builtin:compound-engineering");
    // Plugin-gated built-ins may be unavailable through the store in a bare test
    // project; the pure overlay test covers CE compilation directly.
    if (ceDef) {
      const ceTask = await store.createTask({ description: "compound", workflowId: "builtin:compound-engineering" });
      const ceSteps = await Promise.all((ceTask.enabledWorkflowSteps ?? []).map((id) => store.getWorkflowStep(id)));
      expect(ceSteps.find((step) => step?.name === "Plan")?.prompt).toBe("Plan materialized override");
    }
    expect(ceIr.nodes.find((node) => node.id === "plan")?.config?.prompt).toBe(originalPlan);
  });

  it("migration 128 creates the prompt override table and project index on existing databases", async () => {
    await harness.reopenDiskBackedStore();
    const store = harness.store();
    const db = store.getDatabase();
    db.prepare("DROP INDEX IF EXISTS idx_workflow_prompt_overrides_project").run();
    db.prepare("DROP TABLE IF EXISTS workflow_prompt_overrides").run();
    db.prepare("UPDATE __meta SET value = '127' WHERE key = 'schemaVersion'").run();

    await harness.reopenDiskBackedStore();

    const migratedDb = harness.store().getDatabase();
    const table = migratedDb
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workflow_prompt_overrides'")
      .get();
    const index = migratedDb
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_workflow_prompt_overrides_project'")
      .get();
    expect(table).toBeDefined();
    expect(index).toBeDefined();
  });
});
