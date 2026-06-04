import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Play, Flag, MessageSquare, Terminal, Shield, GitMerge, PauseCircle, Split, Merge, AlertTriangle } from "lucide-react";

/** Node kinds the editor can render. "merge" is the pre/post-merge seam marker.
 *  v2 adds "hold" (passive dwell), "split"/"join" (parallel fan-out). */
export type WorkflowEditorNodeKind =
  | "start"
  | "end"
  | "prompt"
  | "script"
  | "gate"
  | "merge"
  | "hold"
  | "split"
  | "join";

export interface WorkflowFlowNodeData {
  kind: WorkflowEditorNodeKind;
  label: string;
  /** Mirrors the IR node config (prompt, scriptName, gateMode, model, release,
   *  join mode/failure policy…). */
  config?: Record<string, unknown>;
  /** v2: the workflow column this node is placed in (derived from the swimlane
   *  band it sits in). Surfaced for the unplaced-node error badge. */
  column?: string;
  /** When true, render the shared error-state badge on the node (unplaced node
   *  or seam-in-branch). Set by the editor from validation. */
  errorBadge?: string;
  [key: string]: unknown;
}

const KIND_ICON: Record<WorkflowEditorNodeKind, typeof Play> = {
  start: Play,
  end: Flag,
  prompt: MessageSquare,
  script: Terminal,
  gate: Shield,
  merge: GitMerge,
  hold: PauseCircle,
  split: Split,
  join: Merge,
};

/** Shared error-state component (U10): one component renders both the
 *  unplaced-node and the seam-in-branch error as an inline badge on the node. */
export function WorkflowNodeErrorBadge({ message }: { message: string }) {
  return (
    <span className="wf-node-error-badge" role="alert" data-testid="wf-node-error-badge" title={message}>
      <AlertTriangle size={11} aria-hidden /> {message}
    </span>
  );
}

function NodeShell({ data, kind }: { data: WorkflowFlowNodeData; kind: WorkflowEditorNodeKind }) {
  const Icon = KIND_ICON[kind];
  const showTarget = kind !== "start";
  const showSource = kind !== "end";
  const release = kind === "hold" ? (data.config?.release as string | undefined) : undefined;
  const joinMode =
    kind === "join"
      ? (() => {
          const m = data.config?.mode as unknown;
          if (m && typeof m === "object" && "quorum" in (m as object)) {
            return `quorum(${(m as { quorum: number }).quorum})`;
          }
          return typeof m === "string" ? m : "all";
        })()
      : undefined;
  return (
    <div
      className={`wf-node wf-node-${kind}${data.errorBadge ? " wf-node--error" : ""}`}
      data-testid={`wf-node-${kind}`}
    >
      {showTarget && <Handle type="target" position={Position.Left} />}
      <span className="wf-node-icon">
        <Icon size={14} aria-hidden />
      </span>
      <span className="wf-node-label">{data.label || kind}</span>
      {kind === "gate" && <span className="wf-node-badge">gate</span>}
      {release && <span className="wf-node-badge">{release}</span>}
      {joinMode && <span className="wf-node-badge">{joinMode}</span>}
      {data.errorBadge && <WorkflowNodeErrorBadge message={data.errorBadge} />}
      {showSource && <Handle type="source" position={Position.Right} />}
    </div>
  );
}

export const workflowNodeTypes = {
  start: ({ data }: NodeProps) => <NodeShell data={data as WorkflowFlowNodeData} kind="start" />,
  end: ({ data }: NodeProps) => <NodeShell data={data as WorkflowFlowNodeData} kind="end" />,
  prompt: ({ data }: NodeProps) => <NodeShell data={data as WorkflowFlowNodeData} kind="prompt" />,
  script: ({ data }: NodeProps) => <NodeShell data={data as WorkflowFlowNodeData} kind="script" />,
  gate: ({ data }: NodeProps) => <NodeShell data={data as WorkflowFlowNodeData} kind="gate" />,
  merge: ({ data }: NodeProps) => <NodeShell data={data as WorkflowFlowNodeData} kind="merge" />,
  hold: ({ data }: NodeProps) => <NodeShell data={data as WorkflowFlowNodeData} kind="hold" />,
  split: ({ data }: NodeProps) => <NodeShell data={data as WorkflowFlowNodeData} kind="split" />,
  join: ({ data }: NodeProps) => <NodeShell data={data as WorkflowFlowNodeData} kind="join" />,
};
