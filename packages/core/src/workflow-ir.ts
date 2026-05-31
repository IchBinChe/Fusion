import {
  WORKFLOW_IR_NODE_KINDS,
  WORKFLOW_IR_SCHEMA_VERSION,
  type JsonValue,
  type WorkflowIr,
  type WorkflowIrEdge,
  type WorkflowIrMetadata,
  type WorkflowIrNode,
  type WorkflowIrNodeKind,
} from "./workflow-ir-types.js";

const WORKFLOW_IR_NODE_KIND_SET = new Set<WorkflowIrNodeKind>(WORKFLOW_IR_NODE_KINDS);

type WorkflowIrErrorCode = "unsupported_version" | "invalid_shape" | "dangling_edge";

/**
 * Error thrown when workflow IR parsing or validation fails.
 */
export class WorkflowIrError extends Error {
  constructor(
    message: string,
    readonly code: WorkflowIrErrorCode,
  ) {
    super(message);
    this.name = "WorkflowIrError";
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  const valueType = typeof value;
  if (valueType === "string" || valueType === "number" || valueType === "boolean") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry));
  }
  if (!isObjectRecord(value)) {
    return false;
  }
  return Object.values(value).every((entry) => isJsonValue(entry));
}

function parseNode(input: unknown, index: number): WorkflowIrNode {
  if (!isObjectRecord(input)) {
    throw new WorkflowIrError(`Node at index ${index} must be an object.`, "invalid_shape");
  }
  const { id, kind, label, config } = input;
  if (typeof id !== "string" || id.length === 0) {
    throw new WorkflowIrError(`Node at index ${index} has an invalid id.`, "invalid_shape");
  }
  if (typeof kind !== "string" || !WORKFLOW_IR_NODE_KIND_SET.has(kind as WorkflowIrNodeKind)) {
    throw new WorkflowIrError(`Node ${id} has unknown kind: ${String(kind)}.`, "invalid_shape");
  }
  const parsedKind = kind as WorkflowIrNodeKind;
  if (label !== undefined && typeof label !== "string") {
    throw new WorkflowIrError(`Node ${id} label must be a string when provided.`, "invalid_shape");
  }
  if (config !== undefined) {
    if (!isObjectRecord(config) || !isJsonValue(config)) {
      throw new WorkflowIrError(`Node ${id} config must be a JSON-serializable object.`, "invalid_shape");
    }
  }
  return {
    id,
    kind: parsedKind,
    ...(label !== undefined ? { label } : {}),
    ...(config !== undefined ? { config: config as Record<string, JsonValue> } : {}),
  };
}

function parseEdge(input: unknown, index: number): WorkflowIrEdge {
  if (!isObjectRecord(input)) {
    throw new WorkflowIrError(`Edge at index ${index} must be an object.`, "invalid_shape");
  }
  const { id, from, to, condition } = input;
  if (typeof id !== "string" || id.length === 0) {
    throw new WorkflowIrError(`Edge at index ${index} has an invalid id.`, "invalid_shape");
  }
  if (typeof from !== "string" || from.length === 0 || typeof to !== "string" || to.length === 0) {
    throw new WorkflowIrError(`Edge ${id} must include non-empty from/to node ids.`, "invalid_shape");
  }
  if (condition !== undefined && typeof condition !== "string") {
    throw new WorkflowIrError(`Edge ${id} condition must be a string when provided.`, "invalid_shape");
  }
  return {
    id,
    from,
    to,
    ...(condition !== undefined ? { condition } : {}),
  };
}

function parseMetadata(input: unknown): WorkflowIrMetadata {
  if (!isObjectRecord(input)) {
    throw new WorkflowIrError("Workflow metadata must be an object.", "invalid_shape");
  }
  if (typeof input.name !== "string" || input.name.length === 0) {
    throw new WorkflowIrError("Workflow metadata.name must be a non-empty string.", "invalid_shape");
  }
  if (input.description !== undefined && typeof input.description !== "string") {
    throw new WorkflowIrError("Workflow metadata.description must be a string when provided.", "invalid_shape");
  }
  if (input.createdAt !== undefined && typeof input.createdAt !== "string") {
    throw new WorkflowIrError("Workflow metadata.createdAt must be a string when provided.", "invalid_shape");
  }

  const metadata: WorkflowIrMetadata = {
    name: input.name,
  };

  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (!isJsonValue(value)) {
      throw new WorkflowIrError(`Workflow metadata.${key} must be JSON-serializable.`, "invalid_shape");
    }
    metadata[key] = value;
  }

  return metadata;
}

/**
 * Parse and validate workflow IR from a JSON string or object.
 */
export function parseWorkflowIr(input: unknown): WorkflowIr {
  const parsedInput =
    typeof input === "string"
      ? (() => {
          try {
            return JSON.parse(input) as unknown;
          } catch {
            throw new WorkflowIrError("Workflow IR JSON could not be parsed.", "invalid_shape");
          }
        })()
      : input;

  if (!isObjectRecord(parsedInput)) {
    throw new WorkflowIrError("Workflow IR must be an object.", "invalid_shape");
  }

  if (parsedInput.schemaVersion !== WORKFLOW_IR_SCHEMA_VERSION) {
    throw new WorkflowIrError(
      `Unsupported workflow IR schemaVersion: ${String(parsedInput.schemaVersion)}.`,
      "unsupported_version",
    );
  }

  if (!Array.isArray(parsedInput.nodes) || !Array.isArray(parsedInput.edges)) {
    throw new WorkflowIrError("Workflow IR nodes and edges must be arrays.", "invalid_shape");
  }

  const metadata = parseMetadata(parsedInput.metadata);
  const nodes = parsedInput.nodes.map((node, index) => parseNode(node, index));
  const edges = parsedInput.edges.map((edge, index) => parseEdge(edge, index));

  const nodeIds = new Set(nodes.map((node) => node.id));
  for (const edge of edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      throw new WorkflowIrError(
        `Edge ${edge.id} references missing node ids: ${edge.from} -> ${edge.to}.`,
        "dangling_edge",
      );
    }
  }

  return {
    schemaVersion: WORKFLOW_IR_SCHEMA_VERSION,
    metadata,
    nodes,
    edges,
  };
}

/**
 * Serialize workflow IR as JSON.
 */
export function serializeWorkflowIr(ir: WorkflowIr): string {
  return JSON.stringify(ir);
}

/**
 * Canonical built-in workflow IR fixture for v1 interpreter parity tests.
 */
export const BUILTIN_WORKFLOW_IR_FIXTURE: WorkflowIr = {
  schemaVersion: WORKFLOW_IR_SCHEMA_VERSION,
  metadata: {
    name: "Documentation Review Workflow",
    description: "Built-in documentation review path using prompt and gate nodes.",
    createdAt: "2026-05-30T00:00:00.000Z",
    templateId: "documentation-review",
  },
  nodes: [
    {
      id: "node-start",
      kind: "start",
      label: "Start",
    },
    {
      id: "node-prompt-review",
      kind: "prompt",
      label: "Run documentation review prompt",
      config: {
        promptTemplate: "documentation-review",
        reviewLevel: 1,
      },
    },
    {
      id: "node-gate-approval",
      kind: "gate",
      label: "Review approved?",
      config: {
        mode: "approval",
      },
    },
    {
      id: "node-end",
      kind: "end",
      label: "Finish",
    },
  ],
  edges: [
    {
      id: "edge-start-to-prompt",
      from: "node-start",
      to: "node-prompt-review",
    },
    {
      id: "edge-prompt-to-gate",
      from: "node-prompt-review",
      to: "node-gate-approval",
    },
    {
      id: "edge-gate-to-end",
      from: "node-gate-approval",
      to: "node-end",
      condition: "approved",
    },
  ],
};
