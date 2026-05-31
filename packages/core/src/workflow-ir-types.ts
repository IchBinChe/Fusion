/**
 * Workflow IR schema version supported by this runtime.
 */
export const WORKFLOW_IR_SCHEMA_VERSION = "1.0.0" as const;

/**
 * Supported workflow IR schema version literal.
 */
export type WorkflowIrSchemaVersion = typeof WORKFLOW_IR_SCHEMA_VERSION;

/**
 * Built-in workflow IR node kinds available in v1.
 */
export const WORKFLOW_IR_NODE_KINDS = [
  "start",
  "prompt",
  "script",
  "gate",
  "end",
] as const;

/**
 * Union of allowed built-in workflow IR node kinds.
 */
export type WorkflowIrNodeKind = typeof WORKFLOW_IR_NODE_KINDS[number];

/**
 * JSON-serializable primitive value.
 */
export type JsonPrimitive = string | number | boolean | null;

/**
 * JSON-serializable value.
 */
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

/**
 * JSON object map for serializable structures.
 */
export interface JsonObject {
  [key: string]: JsonValue;
}

/**
 * JSON array for serializable structures.
 */
export type JsonArray = JsonValue[];

/**
 * Workflow IR node.
 */
export interface WorkflowIrNode {
  /** Stable node identifier unique within a workflow document. */
  id: string;
  /** Built-in workflow node kind. */
  kind: WorkflowIrNodeKind;
  /** Optional human-readable label for editor/interpreter diagnostics. */
  label?: string;
  /** JSON-safe node configuration payload. */
  config?: Record<string, JsonValue>;
}

/**
 * Workflow IR edge connecting two nodes.
 */
export interface WorkflowIrEdge {
  /** Stable edge identifier unique within a workflow document. */
  id: string;
  /** Source node id. */
  from: string;
  /** Target node id. */
  to: string;
  /** Optional condition expression controlling edge traversal. */
  condition?: string;
}

/**
 * Workflow IR metadata.
 */
export interface WorkflowIrMetadata {
  /** Workflow name. */
  name: string;
  /** Optional workflow description. */
  description?: string;
  /** Optional ISO-8601 creation timestamp string. */
  createdAt?: string;
  /** Additional JSON-safe metadata fields. */
  [k: string]: JsonValue | undefined;
}

/**
 * Versioned, serializable workflow intermediate representation.
 */
export interface WorkflowIr {
  /** Schema version tag for compatibility checks. */
  schemaVersion: WorkflowIrSchemaVersion;
  /** Workflow metadata payload. */
  metadata: WorkflowIrMetadata;
  /** Workflow node list. */
  nodes: WorkflowIrNode[];
  /** Workflow edge list. */
  edges: WorkflowIrEdge[];
}
