import type { Edge as FlowEdge, Node as FlowNode } from "@xyflow/react";
import type { WorkflowIrColumn } from "@fusion/core";
import type { WorkflowFlowNodeData } from "./nodes/WorkflowNodeTypes";
import {
  columnIdFromBandNode,
  isColumnBandNode,
  templateNodeIdFromChild,
} from "./workflow-flow-mapping";
import { nodeConfigSummary, type NodeSummaryCatalogs, type SummaryTranslate } from "./nodes/node-summary";

export interface MobileWorkflowEdgeSummary {
  id: string;
  source: string;
  target: string;
  targetLabel: string;
  label: string;
  kind?: string;
}

export interface MobileWorkflowNodeSummary {
  id: string;
  label: string;
  kind: WorkflowFlowNodeData["kind"];
  summary: string;
  columnName?: string;
  editable: boolean;
  parentId?: string;
  templateLocalId?: string;
  outgoing: MobileWorkflowEdgeSummary[];
  children: MobileWorkflowNodeSummary[];
}

function edgeLabel(edge: FlowEdge): string {
  if (typeof edge.label === "string" && edge.label.trim()) return edge.label;
  return String(edge.data?.condition ?? "success");
}

function nodeDisplayLabel(node: FlowNode<WorkflowFlowNodeData>): string {
  return node.data.label || node.id;
}

function nodeSortValue(node: FlowNode<WorkflowFlowNodeData>): number {
  return Math.round(node.position.y) * 100000 + Math.round(node.position.x);
}

function buildColumnNameMap(columns: WorkflowIrColumn[], nodes: FlowNode<WorkflowFlowNodeData>[]) {
  const names = new Map(columns.map((column) => [column.id, column.name || column.id]));
  for (const node of nodes) {
    if (!isColumnBandNode(node.id)) continue;
    const id = columnIdFromBandNode(node.id);
    if (!names.has(id)) names.set(id, node.data.label || id);
  }
  return names;
}

export function buildMobileWorkflowGraph(
  nodes: FlowNode<WorkflowFlowNodeData>[],
  edges: FlowEdge[],
  columns: WorkflowIrColumn[] = [],
  catalogs: NodeSummaryCatalogs = {},
  t?: SummaryTranslate,
): MobileWorkflowNodeSummary[] {
  const columnNames = buildColumnNameMap(columns, nodes);
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const childNodesByParent = new Map<string, FlowNode<WorkflowFlowNodeData>[]>();

  for (const node of nodes) {
    if (!node.parentId) continue;
    const list = childNodesByParent.get(node.parentId) ?? [];
    list.push(node);
    childNodesByParent.set(node.parentId, list);
  }

  for (const list of childNodesByParent.values()) {
    list.sort((a, b) => nodeSortValue(a) - nodeSortValue(b));
  }

  const summarizeEdge = (edge: FlowEdge): MobileWorkflowEdgeSummary => {
    const target = nodesById.get(edge.target);
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      targetLabel: target ? nodeDisplayLabel(target) : edge.target,
      label: edgeLabel(edge),
      kind: typeof edge.data?.kind === "string" ? edge.data.kind : undefined,
    };
  };

  const summarizeNode = (node: FlowNode<WorkflowFlowNodeData>): MobileWorkflowNodeSummary => {
    const children = (childNodesByParent.get(node.id) ?? []).map(summarizeNode);
    const columnId = node.data.column;
    return {
      id: node.id,
      label: nodeDisplayLabel(node),
      kind: node.data.kind,
      summary: nodeConfigSummary(node.data, catalogs, t),
      columnName: columnId ? columnNames.get(columnId) ?? columnId : undefined,
      editable: node.data.kind !== "start" && node.data.kind !== "end" && !isColumnBandNode(node.id),
      parentId: node.parentId,
      templateLocalId: node.parentId ? templateNodeIdFromChild(node.parentId, node.id) : undefined,
      outgoing: edges.filter((edge) => edge.source === node.id).map(summarizeEdge),
      children,
    };
  };

  const topLevelNodes = nodes
    .filter((node) => !node.parentId && !isColumnBandNode(node.id))
    .sort((a, b) => nodeSortValue(a) - nodeSortValue(b));

  return topLevelNodes.map(summarizeNode);
}
