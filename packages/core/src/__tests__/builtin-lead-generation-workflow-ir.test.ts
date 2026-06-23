import { describe, expect, it } from "vitest";

import { BUILTIN_LEAD_GENERATION_WORKFLOW_IR } from "../builtin-lead-generation-workflow-ir.js";
import {
  BUILTIN_WORKFLOWS,
  defaultEnabledBuiltinWorkflowIds,
  getBuiltinWorkflow,
} from "../builtin-workflows.js";
import { compileWorkflowToSteps } from "../workflow-compiler.js";
import { parseWorkflowIr, serializeWorkflowIr } from "../workflow-ir.js";

describe("built-in lead-generation workflow IR", () => {
  it("registers as an enabled v2 workflow with the authored custom columns", () => {
    const workflow = getBuiltinWorkflow("builtin:lead-generation");
    expect(workflow).toBeDefined();
    expect(workflow!.kind).toBe("workflow");
    expect(workflow!.ir).toBe(BUILTIN_LEAD_GENERATION_WORKFLOW_IR);
    expect(BUILTIN_WORKFLOWS.some((candidate) => candidate.id === "builtin:lead-generation")).toBe(true);
    expect(defaultEnabledBuiltinWorkflowIds()).toContain("builtin:lead-generation");

    const ir = parseWorkflowIr(workflow!.ir);
    expect(ir.version).toBe("v2");
    if (ir.version !== "v2") throw new Error("expected v2");

    expect(ir.columns.map((column) => column.id)).toEqual([
      "triage",
      "sourcing",
      "qualification",
      "enrichment",
      "outreach",
      "converted",
      "archived",
    ]);
    expect(ir.columns.map((column) => column.traits.map((trait) => trait.trait))).toEqual([
      ["intake"],
      ["timing"],
      ["wip", "timing"],
      ["timing"],
      ["human-review", "stall-detection"],
      ["complete"],
      ["archived"],
    ]);

    expect(ir.columns.filter((column) => column.traits.some((trait) => trait.trait === "intake"))).toHaveLength(1);
    expect(ir.columns.filter((column) => column.traits.some((trait) => trait.trait === "complete"))).toHaveLength(1);
    expect(ir.columns.filter((column) => column.traits.some((trait) => trait.trait === "archived"))).toHaveLength(1);
  });

  it("places every node in a defined column and compiles the linear prompt spine", () => {
    const workflow = getBuiltinWorkflow("builtin:lead-generation")!;
    const ir = parseWorkflowIr(workflow.ir);
    if (ir.version !== "v2") throw new Error("expected v2");

    const columnIds = new Set(ir.columns.map((column) => column.id));
    for (const node of ir.nodes) {
      expect(node.column, node.id).toBeDefined();
      expect(columnIds.has(node.column!), node.id).toBe(true);
    }

    expect(ir.nodes.filter((node) => node.kind === "start")).toHaveLength(1);
    expect(ir.nodes.filter((node) => node.kind === "end")).toHaveLength(1);
    expect(ir.nodes.find((node) => node.id === "start")?.column).toBe("triage");
    expect(ir.nodes.find((node) => node.id === "end")?.column).toBe("converted");
    expect(ir.nodes.find((node) => node.id === "qualification-gate")?.kind).toBe("gate");
    expect((ir.nodes.find((node) => node.id === "qualification-gate")?.config as { gateMode?: string })?.gateMode).toBe(
      "advisory",
    );
    for (const node of ir.nodes.filter((candidate) => candidate.kind === "prompt" || candidate.kind === "gate")) {
      const config = node.config as { prompt?: string; seam?: string } | undefined;
      expect(config?.seam, node.id).toBeUndefined();
      expect(config?.prompt, node.id).toEqual(expect.stringMatching(/lead|prospect|outreach|customer|company/i));
    }
    expect(ir.nodes.find((node) => node.id === "enrich-lead")?.config?.prompt).toContain("fn_task_document_write");
    expect(ir.nodes.find((node) => node.id === "draft-outreach")?.config?.prompt).toContain("fn_task_document_write");

    expect(compileWorkflowToSteps(ir).map((step) => step.name)).toEqual([
      "Source prospects",
      "Qualify lead",
      "Qualification go / no-go",
      "Enrich lead",
      "Draft and send outreach",
    ]);
  });

  it("declares lead fields with expected types and enum options", () => {
    const workflow = getBuiltinWorkflow("builtin:lead-generation")!;
    const ir = parseWorkflowIr(workflow.ir);
    if (ir.version !== "v2") throw new Error("expected v2");

    expect(ir.fields?.map((field) => [field.id, field.type])).toEqual([
      ["company", "string"],
      ["contactName", "string"],
      ["contactEmail", "url"],
      ["leadSource", "enum"],
      ["leadScore", "number"],
      ["leadStatus", "enum"],
    ]);

    const fields = new Map(ir.fields?.map((field) => [field.id, field]));
    expect(fields.get("leadSource")?.options?.map((option) => option.value)).toEqual([
      "referral",
      "inbound",
      "outbound",
      "event",
      "partner",
    ]);
    expect(fields.get("leadStatus")?.options?.map((option) => option.value)).toEqual([
      "new",
      "qualified",
      "contacted",
      "responded",
      "won",
      "lost",
    ]);
    expect(fields.get("company")?.render).toEqual({ placement: "card", widget: "input" });
    expect(fields.get("leadStatus")?.render).toEqual({ placement: "card", widget: "select" });
  });

  it("round-trips through serialize → parse unchanged", () => {
    const workflow = getBuiltinWorkflow("builtin:lead-generation")!;
    const serialized = serializeWorkflowIr(workflow.ir);
    const reparsed = parseWorkflowIr(serialized);
    expect(serializeWorkflowIr(reparsed)).toBe(serialized);
  });
});
