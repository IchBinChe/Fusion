import type { Node as FlowNode, Edge as FlowEdge } from "@xyflow/react";
import type {
  WorkflowIr,
  WorkflowIrV2,
  WorkflowIrColumn,
  WorkflowDefinition,
} from "@fusion/core";
import type { WorkflowFlowNodeData, WorkflowEditorNodeKind } from "./nodes/WorkflowNodeTypes";

/** Layout geometry for column swimlane bands. Bands stack vertically; each band
 *  is full-width and a node's `column` is derived by hit-testing the node's y
 *  against the band rows (position-based, so the editor's existing absolute
 *  layout persistence carries over unchanged — see flowToIr). */
export const COLUMN_BAND_HEIGHT = 220;
export const COLUMN_BAND_WIDTH = 5000;
export const COLUMN_BAND_X = -40;
export const COLUMN_BAND_TOP = 0;
/** React Flow node id for a column band group node. */
export const columnBandNodeId = (columnId: string): string => `__col__:${columnId}`;
export const isColumnBandNode = (id: string): boolean => id.startsWith("__col__:");
export const columnIdFromBandNode = (id: string): string => id.slice("__col__:".length);

/** The y-origin of the band for the column at `index`. */
export function bandTop(index: number): number {
  return COLUMN_BAND_TOP + index * COLUMN_BAND_HEIGHT;
}

/** Hit-test a y coordinate against the ordered column bands, returning the
 *  column id whose band contains it (clamped to the first/last band). Returns
 *  undefined when there are no columns. Use for drag placement (a dropped node
 *  always snaps to the nearest band). */
export function columnForY(y: number, columns: WorkflowIrColumn[]): string | undefined {
  if (columns.length === 0) return undefined;
  const idx = Math.floor((y - COLUMN_BAND_TOP) / COLUMN_BAND_HEIGHT);
  const clamped = Math.max(0, Math.min(columns.length - 1, idx));
  return columns[clamped]?.id;
}

/** Strict (non-clamping) hit test: returns the column id whose band vertically
 *  contains `y`, or undefined when `y` falls outside every band. Use for
 *  unplaced-node detection (a node parked above/below all bands is unplaced). */
export function strictColumnForY(y: number, columns: WorkflowIrColumn[]): string | undefined {
  if (columns.length === 0) return undefined;
  const idx = Math.floor((y - COLUMN_BAND_TOP) / COLUMN_BAND_HEIGHT);
  if (idx < 0 || idx >= columns.length) return undefined;
  return columns[idx]?.id;
}

/** True when the IR is v2 (has columns). */
function isV2(ir: WorkflowIr): ir is WorkflowIrV2 {
  return ir.version === "v2";
}

/** Resolve the editor node "type" for an IR node (merge seam → "merge"). */
function editorKind(node: WorkflowIr["nodes"][number]): WorkflowEditorNodeKind {
  const seam = node.config?.seam;
  if (seam === "merge") return "merge";
  return node.kind;
}

function nodeLabel(node: WorkflowIr["nodes"][number]): string {
  const name = node.config?.name;
  if (typeof name === "string" && name.trim()) return name;
  if (node.config?.seam === "merge") return "Merge boundary";
  return node.id;
}

/** Build React Flow swimlane band group nodes from the workflow's columns. */
export function columnsToBandNodes(columns: WorkflowIrColumn[]): FlowNode<WorkflowFlowNodeData>[] {
  return columns.map((col, index): FlowNode<WorkflowFlowNodeData> => ({
    id: columnBandNodeId(col.id),
    type: "group",
    position: { x: COLUMN_BAND_X, y: bandTop(index) },
    data: { kind: "start", label: col.name, column: col.id } as unknown as WorkflowFlowNodeData,
    draggable: false,
    selectable: false,
    deletable: false,
    // Bands sit behind step nodes so steps remain clickable/draggable.
    zIndex: -1,
    style: {
      width: COLUMN_BAND_WIDTH,
      height: COLUMN_BAND_HEIGHT,
    },
    className: "wf-column-band",
  }));
}

/** Build React Flow nodes/edges from a stored workflow definition. v2 columns
 *  render as swimlane band group nodes; step nodes carry their `column`. */
export function irToFlow(def: WorkflowDefinition): {
  nodes: FlowNode<WorkflowFlowNodeData>[];
  edges: FlowEdge[];
} {
  const columns = isV2(def.ir) ? def.ir.columns : [];
  const bandNodes = columnsToBandNodes(columns);

  const stepNodes = def.ir.nodes.map((node, index): FlowNode<WorkflowFlowNodeData> => {
    const pos = def.layout?.[node.id];
    const kind = editorKind(node);
    const column = isV2(def.ir) ? node.column : undefined;
    const colIndex = column ? columns.findIndex((c) => c.id === column) : -1;
    // Default placement seeds the node inside its column band when no persisted
    // layout exists; otherwise we honor the saved absolute position.
    const fallbackY = colIndex >= 0 ? bandTop(colIndex) + 70 : 120;
    return {
      id: node.id,
      type: kind,
      position: pos ?? { x: 80 + index * 180, y: fallbackY },
      data: {
        kind,
        label: nodeLabel(node),
        config: { ...(node.config ?? {}) },
        column,
      },
      deletable: node.kind !== "start" && node.kind !== "end",
    };
  });

  const edges = def.ir.edges.map((edge, index): FlowEdge => {
    const condition = edge.condition ?? "success";
    return {
      id: `e-${edge.from}-${edge.to}-${index}`,
      source: edge.from,
      target: edge.to,
      label: condition,
      data: { condition },
    };
  });

  return { nodes: [...bandNodes, ...stepNodes], edges };
}

/** Sanitize a node config, applying the v1 round-trip name rules. */
function nodeConfig(node: FlowNode<WorkflowFlowNodeData>): Record<string, unknown> | undefined {
  const data = node.data;
  const config: Record<string, unknown> = { ...(data.config ?? {}) };
  const fallbackLabel = data.kind === "merge" ? "Merge boundary" : node.id;
  if (data.kind !== "start" && data.kind !== "end" && data.label && data.label !== fallbackLabel) {
    config.name = data.label;
  } else {
    delete config.name;
  }
  return config;
}

/**
 * Project React Flow nodes/edges back into a WorkflowIr plus a layout map.
 *
 * When `columns` is provided (the editor manages columns via WorkflowColumnPanel)
 * the result is a **v2** IR: column bands are dropped, each step node's `column`
 * is derived by hit-testing its y against the ordered bands, and split/join/hold
 * config is preserved verbatim. With no columns the result is a v1 IR (legacy
 * round-trip, byte-compatible with the pre-U10 mapping).
 */
export function flowToIr(
  name: string,
  nodes: FlowNode<WorkflowFlowNodeData>[],
  edges: FlowEdge[],
  columns?: WorkflowIrColumn[],
): { ir: WorkflowIr; layout: Record<string, { x: number; y: number }> } {
  const stepNodes = nodes.filter((n) => !isColumnBandNode(n.id) && n.type !== "group");
  const v2 = Array.isArray(columns) && columns.length > 0;

  const irNodes: WorkflowIr["nodes"] = stepNodes.map((node) => {
    const data = node.data;
    const config = nodeConfig(node);
    // Derive column placement from the node's y position relative to the bands.
    const column = v2 ? data.column ?? columnForY(node.position.y, columns!) : undefined;
    if (data.kind === "merge") {
      const cfg = { ...(config ?? {}), seam: "merge" };
      return { id: node.id, kind: "prompt" as const, ...(column ? { column } : {}), config: cfg };
    }
    return {
      id: node.id,
      kind: data.kind,
      ...(column ? { column } : {}),
      config: config && Object.keys(config).length ? config : undefined,
    };
  });

  const irEdges: WorkflowIr["edges"] = edges.map((edge) => {
    const condition = (edge.data?.condition as string | undefined) ?? "success";
    return { from: edge.source, to: edge.target, condition };
  });

  const layout = stepNodes.reduce<Record<string, { x: number; y: number }>>((acc, node) => {
    acc[node.id] = { x: Math.round(node.position.x), y: Math.round(node.position.y) };
    return acc;
  }, {});

  if (v2) {
    const ir: WorkflowIrV2 = {
      version: "v2",
      name,
      columns: columns!.map((c) => ({ id: c.id, name: c.name, traits: c.traits })),
      nodes: irNodes,
      edges: irEdges,
    };
    return { ir, layout };
  }

  return { ir: { version: "v1", name, nodes: irNodes, edges: irEdges }, layout };
}

// ── Client-side validation (U10) ─────────────────────────────────────────────
//
// The server's parseWorkflowIr (run on PATCH) is the authority for structural
// errors (undefined-column references, seam-in-branch, duplicate column ids).
// These two helpers run client-side so the editor can render precise inline
// badges and block the save before a round-trip:
//   - composition violations attributed to the offending column band;
//   - unplaced-node errors attributed to the offending step node.
// They mirror @fusion/core's validateColumnTraits rules using the catalog flags
// (the catalog endpoint ships the same flags the registry validates against).

import type { TraitViolation } from "@fusion/core";
import type { TraitCatalogEntry } from "../api";

type CatalogFlags = TraitCatalogEntry["flags"];

function mergedFlags(
  traits: WorkflowIrColumn["traits"],
  catalog: Map<string, TraitCatalogEntry>,
): { flags: CatalogFlags; capacityTraitIds: string[]; unknown: string[] } {
  const flags: CatalogFlags = {};
  const capacityTraitIds: string[] = [];
  const unknown: string[] = [];
  for (const ct of traits) {
    const def = catalog.get(ct.trait);
    if (!def) {
      unknown.push(ct.trait);
      continue;
    }
    for (const [k, v] of Object.entries(def.flags)) {
      if (v) (flags as Record<string, boolean>)[k] = true;
    }
    if (def.flags.countsTowardWip) capacityTraitIds.push(def.id);
  }
  return { flags, capacityTraitIds, unknown };
}

/** Client mirror of core's validateColumnTraits, driven by the trait catalog. */
export function validateColumnsClient(
  columns: WorkflowIrColumn[],
  catalog: TraitCatalogEntry[],
): TraitViolation[] {
  const byId = new Map(catalog.map((c) => [c.id, c]));
  const violations: TraitViolation[] = [];
  let intakeCount = 0;

  for (const col of columns) {
    const { flags, capacityTraitIds, unknown } = mergedFlags(col.traits, byId);
    for (const u of unknown) {
      violations.push({
        code: "unknown-trait",
        severity: "error",
        columnId: col.id,
        traitIds: [u],
        message: `Column '${col.id}' references unknown trait '${u}'`,
      });
    }
    if (flags.complete && flags.countsTowardWip) {
      violations.push({
        code: "complete-with-wip",
        severity: "error",
        columnId: col.id,
        traitIds: capacityTraitIds,
        message: `Column '${col.name || col.id}' is both a completion column and counts toward WIP`,
      });
    }
    if (capacityTraitIds.length > 1) {
      violations.push({
        code: "two-capacity-traits",
        severity: "error",
        columnId: col.id,
        traitIds: capacityTraitIds,
        message: `Column '${col.name || col.id}' has more than one capacity (WIP) trait`,
      });
    }
    if (flags.complete && flags.intake) {
      violations.push({
        code: "complete-with-intake",
        severity: "error",
        columnId: col.id,
        traitIds: [],
        message: `Column '${col.name || col.id}' is both a completion column and an intake column`,
      });
    }
    if (flags.archived && flags.countsTowardWip) {
      violations.push({
        code: "archived-with-wip",
        severity: "error",
        columnId: col.id,
        traitIds: [],
        message: `Column '${col.name || col.id}' is archived but counts toward WIP`,
      });
    }
    if (flags.intake) intakeCount += 1;
  }

  if (intakeCount > 1) {
    violations.push({
      code: "multiple-intake-columns",
      severity: "error",
      columnId: null,
      traitIds: [],
      message: `Workflow has ${intakeCount} intake columns; exactly one is allowed`,
    });
  }

  return violations;
}

/** Step node ids that are not placed in any column (v2 only). Bands and
 *  start/end are exempt — start/end are structural and need no column. */
export function unplacedNodeIds(
  nodes: FlowNode<WorkflowFlowNodeData>[],
  columns: WorkflowIrColumn[],
): string[] {
  if (columns.length === 0) return [];
  const ids: string[] = [];
  for (const node of nodes) {
    if (isColumnBandNode(node.id) || node.type === "group") continue;
    if (node.data.kind === "start" || node.data.kind === "end") continue;
    // A node is placed if it carries a valid column id, or if its y falls
    // strictly within a band's extent. A node parked outside every band with
    // no explicit column is unplaced (blocks save with an inline badge).
    const explicit = node.data.column;
    if (explicit && columns.some((c) => c.id === explicit)) continue;
    if (explicit && !columns.some((c) => c.id === explicit)) {
      ids.push(node.id);
      continue;
    }
    const byPosition = strictColumnForY(node.position.y, columns);
    if (!byPosition) ids.push(node.id);
  }
  return ids;
}

/** Extract the editor's working column list from a definition (v2 → its
 *  columns; v1 → empty, meaning "no custom columns authored yet"). */
export function columnsOf(def: WorkflowDefinition): WorkflowIrColumn[] {
  return isV2(def.ir) ? def.ir.columns.map((c) => ({ ...c, traits: [...c.traits] })) : [];
}

/** Seed graph for a brand-new workflow: start → end with room to insert steps. */
export function emptyWorkflowIr(name: string): WorkflowIr {
  return {
    version: "v1",
    name,
    nodes: [
      { id: "start", kind: "start" },
      { id: "end", kind: "end" },
    ],
    edges: [{ from: "start", to: "end", condition: "success" }],
  };
}

export function emptyWorkflowLayout(): Record<string, { x: number; y: number }> {
  return { start: { x: 80, y: 140 }, end: { x: 460, y: 140 } };
}
