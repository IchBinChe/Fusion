import { describe, expect, it } from "vitest";
import {
  BUILTIN_CODING_WORKFLOW_IR,
  DEFAULT_WORKFLOW_COLUMN_IDS,
  parseWorkflowIr,
  serializeWorkflowIr,
} from "../index.js";

const EXECUTE_NODE_MAX_RETRIES = 2;

function executeNodeConfig(ir = BUILTIN_CODING_WORKFLOW_IR): Record<string, unknown> {
  const executeNodes = ir.nodes.filter((node) => node.id === "execute" && node.config?.seam === "execute");
  expect(executeNodes).toHaveLength(1);
  const config = executeNodes[0].config;
  expect(config).toBeDefined();
  expect(Object.keys(config ?? {})).not.toHaveLength(0);
  return config ?? {};
}

describe("builtin coding workflow ir", () => {
  it("parses and round-trips", () => {
    const parsed = parseWorkflowIr(BUILTIN_CODING_WORKFLOW_IR);
    const reparsed = parseWorkflowIr(serializeWorkflowIr(parsed));
    expect(reparsed).toEqual(parsed);
    // The built-in default workflow is now a v2 graph (columns + placement).
    expect(parsed.version).toBe("v2");
  });

  it("contains exactly one start and one end node", () => {
    const nodes = BUILTIN_CODING_WORKFLOW_IR.nodes;
    expect(nodes.filter((node) => node.kind === "start")).toHaveLength(1);
    expect(nodes.filter((node) => node.kind === "end")).toHaveLength(1);
  });

  it("exposes coding lifecycle seams", () => {
    const seams = BUILTIN_CODING_WORKFLOW_IR.nodes
      .map((node) => String(node.config?.seam ?? ""))
      .filter((seam) => seam.length > 0);
    expect(seams).toEqual(expect.arrayContaining(["execute", "workflow-step", "review", "merge"]));
    expect(seams).not.toContain("triage");
  });

  it("defines the six legacy columns in legacy order (KTD-1)", () => {
    expect(BUILTIN_CODING_WORKFLOW_IR.version).toBe("v2");
    if (BUILTIN_CODING_WORKFLOW_IR.version !== "v2") throw new Error("expected v2");
    const ids = BUILTIN_CODING_WORKFLOW_IR.columns.map((c) => c.id);
    expect(ids).toEqual([...DEFAULT_WORKFLOW_COLUMN_IDS]);
    expect(ids).toEqual(["triage", "todo", "in-progress", "in-review", "done", "archived"]);
  });

  it("maps default-workflow traits to columns verbatim (R12)", () => {
    if (BUILTIN_CODING_WORKFLOW_IR.version !== "v2") throw new Error("expected v2");
    const byId = new Map(BUILTIN_CODING_WORKFLOW_IR.columns.map((c) => [c.id, c]));
    const traitsFor = (id: string) => byId.get(id)!.traits.map((t) => t.trait);
    expect(traitsFor("triage")).toEqual(["intake"]);
    expect(traitsFor("todo")).toEqual(["hold", "reset-on-entry"]);
    expect(traitsFor("in-progress")).toEqual(["wip", "abort-on-exit", "timing"]);
    expect(traitsFor("in-review")).toEqual(["merge-blocker", "human-review", "stall-detection", "merge"]);
    expect(traitsFor("done")).toEqual(["complete"]);
    expect(traitsFor("archived")).toEqual(["archived"]);
    // todo's hold is capacity-released (legacy "pull from todo when a slot frees").
    const hold = byId.get("todo")!.traits.find((t) => t.trait === "hold");
    expect(hold?.config?.release).toBe("capacity");
  });

  it("places seam nodes in their columns", () => {
    const byId = new Map(BUILTIN_CODING_WORKFLOW_IR.nodes.map((n) => [n.id, n]));
    expect(byId.get("execute")?.column).toBe("in-progress");
    expect(byId.get("workflow-step")?.column).toBe("in-progress");
    expect(byId.get("review")?.column).toBe("in-review");
    expect(byId.get("merge")?.column).toBe("in-review");
  });

  it("assigns descriptive names to execute/workflow-step/review/merge seam nodes", () => {
    const byId = new Map(BUILTIN_CODING_WORKFLOW_IR.nodes.map((n) => [n.id, n]));
    expect(byId.get("execute")?.config?.name).toBe("Execute");
    expect(byId.get("workflow-step")?.config?.name).toBe("Pre-merge workflow steps");
    expect(byId.get("review")?.config?.name).toBe("Review");
    expect(byId.get("merge")?.config?.name).toBe("Merge boundary");
  });

  it("declares a bounded retry budget only on the execute seam", () => {
    const config = executeNodeConfig();
    expect(config.maxRetries).toBe(EXECUTE_NODE_MAX_RETRIES);
    expect(Number.isInteger(config.maxRetries)).toBe(true);
    expect(config.maxRetries).toBeGreaterThanOrEqual(1);
    expect(config.maxRetries).toBeLessThanOrEqual(10);

    const byId = new Map(BUILTIN_CODING_WORKFLOW_IR.nodes.map((n) => [n.id, n]));
    expect(byId.get("workflow-step")?.config?.name).toBe("Pre-merge workflow steps");
    expect(byId.get("review")?.config?.name).toBe("Review");
    expect(byId.get("merge")?.config?.name).toBe("Merge boundary");
    expect(byId.get("workflow-step")?.config?.maxRetries).toBeUndefined();
    expect(byId.get("review")?.config?.maxRetries).toBeUndefined();
    expect(byId.get("merge")?.config?.maxRetries).toBeUndefined();
  });

  it("preserves the execute retry declaration through parse/serialize round-trip", () => {
    const reparsed = parseWorkflowIr(serializeWorkflowIr(BUILTIN_CODING_WORKFLOW_IR));
    const config = executeNodeConfig(reparsed);
    expect(config.maxRetries).toBe(EXECUTE_NODE_MAX_RETRIES);
  });
});
