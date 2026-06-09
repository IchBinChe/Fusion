import { describe, expect, it } from "vitest";
import type { Edge as FlowEdge, Node as FlowNode } from "@xyflow/react";
import { buildMobileWorkflowGraph } from "../workflow-mobile-graph";
import type { WorkflowFlowNodeData } from "../nodes/WorkflowNodeTypes";
import { columnBandNodeId, foreachChildFlowId } from "../workflow-flow-mapping";

function node(
  id: string,
  kind: WorkflowFlowNodeData["kind"],
  x: number,
  y: number,
  extra: Partial<FlowNode<WorkflowFlowNodeData>> = {},
): FlowNode<WorkflowFlowNodeData> {
  return {
    id,
    type: kind,
    position: { x, y },
    data: { kind, label: id, ...(extra.data ?? {}) },
    ...extra,
  };
}

function edge(id: string, source: string, target: string, condition = "success"): FlowEdge {
  return {
    id,
    source,
    target,
    label: condition,
    data: { condition },
  };
}

describe("buildMobileWorkflowGraph", () => {
  it("returns ordered linear rows with outgoing edge destinations", () => {
    const rows = buildMobileWorkflowGraph(
      [
        node("end", "end", 300, 0),
        node("start", "start", 0, 0),
        node("lint", "gate", 150, 0, { data: { kind: "gate", label: "Lint", config: { gateMode: "gate" } } }),
      ],
      [edge("e1", "start", "lint"), edge("e2", "lint", "end")],
    );

    expect(rows.map((row) => row.id)).toEqual(["start", "lint", "end"]);
    expect(rows[0].outgoing[0]).toMatchObject({ target: "lint", targetLabel: "Lint" });
    expect(rows[1].summary).toBe("Gate (blocks)");
  });

  it("preserves branch edges and column labels while ignoring column band nodes", () => {
    const rows = buildMobileWorkflowGraph(
      [
        node(columnBandNodeId("todo"), "start", -40, 0, {
          type: "group",
          data: { kind: "start", label: "Todo", column: "todo" },
        }),
        node("split", "split", 0, 0, { data: { kind: "split", label: "Split", column: "todo" } }),
        node("a", "prompt", 160, 20, { data: { kind: "prompt", label: "A", column: "todo" } }),
        node("b", "script", 160, 90, { data: { kind: "script", label: "B", column: "todo" } }),
      ],
      [edge("e1", "split", "a", "success"), edge("e2", "split", "b", "failure")],
      [{ id: "todo", name: "Todo", traits: [] }],
    );

    expect(rows.map((row) => row.id)).toEqual(["split", "a", "b"]);
    expect(rows[0].columnName).toBe("Todo");
    expect(rows[0].outgoing.map((out) => [out.label, out.targetLabel])).toEqual([
      ["success", "A"],
      ["failure", "B"],
    ]);
  });

  it("nests foreach template children without exposing local ids as top-level rows", () => {
    const childId = foreachChildFlowId("each", "step");
    const rows = buildMobileWorkflowGraph(
      [
        node("each", "foreach", 0, 0, { data: { kind: "foreach", label: "Each step", config: { mode: "parallel" } } }),
        node(childId, "prompt", 20, 60, {
          parentId: "each",
          data: { kind: "prompt", label: "Run step", config: { seam: "step-execute" } },
        }),
      ],
      [edge("e-child", childId, childId, "outcome:revise")],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("each");
    expect(rows[0].children).toHaveLength(1);
    expect(rows[0].children[0]).toMatchObject({
      id: childId,
      templateLocalId: "step",
      label: "Run step",
    });
  });
});
