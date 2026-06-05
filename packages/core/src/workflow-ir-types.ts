/** Node kinds. v1 kinds (start/prompt/script/gate/end) plus the v2 additions:
 *  `hold` (passive dwell column states), `split`/`join` (parallel fan-out), and
 *  the step-inversion additions (FN step-inversion, KTD-3/4/12/15):
 *  `foreach` (runtime-expanding per-step template region), `step-review`
 *  (per-step review verdicts as outcome edges), `parse-steps` (graph-native
 *  step-list parsing), and `code` (sandboxed TypeScript). */
export type WorkflowIrNodeKind =
  | "start"
  | "prompt"
  | "script"
  | "gate"
  | "end"
  | "hold"
  | "split"
  | "join"
  | "foreach"
  | "step-review"
  | "parse-steps"
  | "code";

export interface WorkflowIrNode {
  id: string;
  kind: WorkflowIrNodeKind;
  /** v2: the column this node is placed in. Must reference a defined column id. */
  column?: string;
  config?: Record<string, unknown>;
}

/**
 * Executor kinds selectable on a prompt/execute node's `config.executor` (CLI
 * Agent Executor, U7). The engine reads `config.executor` as an open string; this
 * union documents the recognized values and `WorkflowNodeExecutorConfig` the
 * fields each one consumes. `config` itself stays an open `Record` so unknown
 * keys remain forward-compatible.
 *
 * - `model`     (default): run the prompt on the configured/override model.
 * - `agent`     : run as a named agent (adopt its model + persona).
 * - `skill`     : invoke a named skill with the prompt as input.
 * - `cli`       : run a named project script with the prompt via env.
 * - `cli-agent` : drive a CLI coding agent (Claude Code / Codex / Droid / Pi /
 *                 generic) in an engine-owned PTY for the execute step. Honors
 *                 cancel/abort/re-entry semantics and positive-completion gating.
 */
export type WorkflowNodeExecutorKind = "model" | "agent" | "skill" | "cli" | "cli-agent";

/**
 * The cli-agent slice of a workflow node's `config`. These ride on the open
 * `WorkflowIrNode.config` record (read at U7's executor seam); they are NOT a
 * separate column. The resolved values are SNAPSHOTTED at session launch — a
 * mid-run edit to the node config applies to the next run only.
 */
export interface WorkflowNodeExecutorConfig {
  /** Selected executor kind for this node. */
  executor?: WorkflowNodeExecutorKind;
  /** cli-agent: adapter id to drive the session (resolved against the registry). */
  cliAdapterId?: string;
  /**
   * cli-agent: autonomy posture (drives privileged flags + resume caps). Stored
   * verbatim; structured but extensible (mirrors `CliAutonomyPosture`).
   */
  cliAutonomy?: {
    autoApprove?: boolean;
    maxResumeAttempts?: number;
    [key: string]: unknown;
  };
  /**
   * cli-agent: notification settings for waiting-on-input events on this node
   * (origin R2/R11). Opaque to the engine seam; forwarded to the dispatch.
   */
  cliNotify?: Record<string, unknown>;
}

export interface WorkflowIrEdge {
  from: string;
  to: string;
  condition?: string;
  /** Step-inversion (KTD-5): `rework` edges are the only legal cycles, scoped to
   *  one foreach template instance and bounded by the foreach `maxReworkCycles`.
   *  They are exempt from cycle/parallelism complaints. */
  kind?: "rework";
}

/** Step-inversion (KTD-3): config for a `foreach` node — a runtime-expanding
 *  template region instantiated once per planned step.
 *  Defaults: `mode` sequential; `isolation` shared for sequential / worktree for
 *  parallel; `concurrency` parallel-only. */
export interface WorkflowForeachConfig {
  source: "task-steps";
  maxReworkCycles?: number;
  mode?: "sequential" | "parallel";
  concurrency?: number;
  isolation?: "shared" | "worktree";
  template: {
    nodes: WorkflowIrNode[];
    edges: WorkflowIrEdge[];
  };
}

/** Step-inversion (KTD-12): a workflow-declared task document. Artifacts ride the
 *  existing task-documents machinery; `step-source` artifacts feed `parse-steps`. */
export interface WorkflowIrArtifact {
  key: string;
  title?: string;
  producedBy?: "planning" | "manual";
  role?: "step-source" | "context";
}

/** Step-inversion (KTD-13): the supported custom-field value types. */
export type WorkflowFieldType =
  | "string"
  | "text"
  | "number"
  | "boolean"
  | "enum"
  | "multi-enum"
  | "date"
  | "url";

/** A single enum/multi-enum option (KTD-13). */
export interface WorkflowFieldOption {
  value: string;
  label: string;
  color?: string;
}

/** Rendering instructions for a custom field (KTD-14). */
export interface WorkflowFieldRender {
  placement?: "card" | "detail" | "detail-section";
  widget?: "select" | "radio" | "chips" | "input" | "textarea" | "toggle";
  badge?: boolean;
}

/** Step-inversion (KTD-13): a workflow-defined custom task field. */
export interface WorkflowFieldDefinition {
  id: string;
  name: string;
  type: WorkflowFieldType;
  required?: boolean;
  default?: unknown;
  options?: WorkflowFieldOption[];
  render?: WorkflowFieldRender;
}

/** A single trait configuration applied to a column. The `trait` is an opaque
 *  registry id (resolved by the trait registry shipped in U2); `config` carries
 *  trait-specific options validated by that trait's schema. */
export interface WorkflowIrColumnTrait {
  trait: string;
  config?: Record<string, unknown>;
}

/** A workflow-defined board column. */
export interface WorkflowIrColumn {
  id: string;
  name: string;
  traits: WorkflowIrColumnTrait[];
}

/** Release conditions for a `hold` node (KTD-2, R3). */
export type WorkflowHoldRelease =
  | "manual"
  | "timer"
  | "capacity"
  | "dependency"
  | "external-event";

/** Join synchronization mode (KTD-11). `quorum` requires `quorum.n` completed branches. */
export type WorkflowJoinMode = "all" | "any" | { quorum: number };

/** What happens to sibling branches when one branch fails before the join (KTD-11). */
export type WorkflowJoinBranchFailure = "fail-fast" | "collect";

/** A v1 workflow IR graph. Frozen by FN-5769; retained for back-compat. */
export interface WorkflowIrV1 {
  version: "v1";
  name: string;
  nodes: WorkflowIrNode[];
  edges: WorkflowIrEdge[];
}

/** A v2 workflow IR graph: v1 plus workflow-defined columns and node placement.
 *  Step-inversion adds optional `artifacts` (KTD-12) and `fields` (KTD-13)
 *  declarations — both additive; absent on legacy graphs. */
export interface WorkflowIrV2 {
  version: "v2";
  name: string;
  columns: WorkflowIrColumn[];
  nodes: WorkflowIrNode[];
  edges: WorkflowIrEdge[];
  artifacts?: WorkflowIrArtifact[];
  fields?: WorkflowFieldDefinition[];
}

/** Either IR version. v1 graphs upgrade to v2 on parse (see parseWorkflowIr). */
export type WorkflowIr = WorkflowIrV1 | WorkflowIrV2;
