import "@xyflow/react/dist/style.css";
import "./WorkflowNodeEditor.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  type Connection,
  type Node as FlowNode,
  type Edge as FlowEdge,
} from "@xyflow/react";
import { X, Plus, Trash2, Save, MessageSquare, Terminal, Shield, GitMerge, Loader2 } from "lucide-react";
import type { WorkflowDefinition } from "@fusion/core";
import { getErrorMessage } from "@fusion/core";
import {
  fetchWorkflows,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  compileWorkflow,
} from "../api";
import type { ToastType } from "../hooks/useToast";
import { useOverlayDismiss } from "../hooks/useOverlayDismiss";
import { useModalResizePersist } from "../hooks/useModalResizePersist";
import { workflowNodeTypes, type WorkflowFlowNodeData, type WorkflowEditorNodeKind } from "./nodes/WorkflowNodeTypes";
import { irToFlow, flowToIr, emptyWorkflowIr, emptyWorkflowLayout } from "./workflow-flow-mapping";

interface WorkflowNodeEditorProps {
  isOpen: boolean;
  onClose: () => void;
  addToast: (message: string, type?: ToastType) => void;
  projectId?: string;
}

let nodeSeq = 0;
function newNodeId(): string {
  nodeSeq += 1;
  return `n-${Date.now().toString(36)}-${nodeSeq}`;
}

const PALETTE: Array<{ kind: WorkflowEditorNodeKind; label: string; icon: typeof MessageSquare }> = [
  { kind: "prompt", label: "Prompt", icon: MessageSquare },
  { kind: "script", label: "Script", icon: Terminal },
  { kind: "gate", label: "Gate", icon: Shield },
  { kind: "merge", label: "Merge boundary", icon: GitMerge },
];

function InnerEditor({
  onClose,
  addToast,
  projectId,
  modalRef,
}: Omit<WorkflowNodeEditorProps, "isOpen"> & { modalRef: React.RefObject<HTMLDivElement | null> }) {
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode<WorkflowFlowNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const activeWorkflow = useMemo(() => workflows.find((w) => w.id === activeId), [workflows, activeId]);

  const loadWorkflows = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchWorkflows(projectId);
      setWorkflows(data);
      setActiveId((prev) => prev ?? data[0]?.id ?? null);
    } catch (err) {
      addToast(getErrorMessage(err) || "Failed to load workflows", "error");
    } finally {
      setLoading(false);
    }
  }, [projectId, addToast]);

  useEffect(() => {
    void loadWorkflows();
  }, [loadWorkflows]);

  // Load the active workflow graph into the canvas.
  useEffect(() => {
    if (!activeWorkflow) {
      setNodes([]);
      setEdges([]);
      return;
    }
    const flow = irToFlow(activeWorkflow);
    setNodes(flow.nodes);
    setEdges(flow.edges);
    setSelectedNodeId(null);
    setValidationError(null);
  }, [activeWorkflow, setNodes, setEdges]);

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((eds) =>
        addEdge({ ...connection, label: "success", data: { condition: "success" } }, eds),
      );
    },
    [setEdges],
  );

  const addNode = useCallback(
    (kind: WorkflowEditorNodeKind) => {
      const id = newNodeId();
      const label = kind === "merge" ? "Merge boundary" : kind.charAt(0).toUpperCase() + kind.slice(1);
      setNodes((ns) => [
        ...ns,
        {
          id,
          type: kind,
          position: { x: 200 + ns.length * 40, y: 240 + (ns.length % 3) * 70 },
          data: { kind, label, config: kind === "gate" ? { gateMode: "gate" } : {} },
          deletable: true,
        },
      ]);
      setSelectedNodeId(id);
    },
    [setNodes],
  );

  const updateSelectedData = useCallback(
    (patch: Partial<WorkflowFlowNodeData> | { config: Record<string, unknown> }) => {
      if (!selectedNodeId) return;
      setNodes((ns) =>
        ns.map((n) =>
          n.id === selectedNodeId
            ? {
                ...n,
                data: {
                  ...n.data,
                  ...("config" in patch ? { config: { ...n.data.config, ...patch.config } } : patch),
                },
              }
            : n,
        ),
      );
    },
    [selectedNodeId, setNodes],
  );

  const handleCreateWorkflow = useCallback(async () => {
    const name = window.prompt("New workflow name");
    if (!name?.trim()) return;
    try {
      const created = await createWorkflow(
        { name: name.trim(), ir: emptyWorkflowIr(name.trim()), layout: emptyWorkflowLayout() },
        projectId,
      );
      setWorkflows((ws) => [...ws, created]);
      setActiveId(created.id);
      addToast(`Created workflow "${created.name}"`, "success");
    } catch (err) {
      addToast(getErrorMessage(err) || "Failed to create workflow", "error");
    }
  }, [projectId, addToast]);

  const handleDeleteWorkflow = useCallback(async () => {
    if (!activeWorkflow) return;
    if (!window.confirm(`Delete workflow "${activeWorkflow.name}"?`)) return;
    try {
      await deleteWorkflow(activeWorkflow.id, projectId);
      setWorkflows((ws) => ws.filter((w) => w.id !== activeWorkflow.id));
      setActiveId(null);
      addToast("Workflow deleted", "success");
    } catch (err) {
      addToast(getErrorMessage(err) || "Failed to delete workflow", "error");
    }
  }, [activeWorkflow, projectId, addToast]);

  const handleSave = useCallback(async () => {
    if (!activeWorkflow) return;
    setSaving(true);
    setValidationError(null);
    try {
      const { ir, layout } = flowToIr(activeWorkflow.name, nodes, edges);
      const updated = await updateWorkflow(activeWorkflow.id, { ir, layout }, projectId);
      setWorkflows((ws) => ws.map((w) => (w.id === updated.id ? updated : w)));
      // Validate by compiling — surfaces non-linear graphs as a banner.
      try {
        await compileWorkflow(updated.id, projectId);
        addToast("Workflow saved", "success");
      } catch (compileErr) {
        setValidationError(getErrorMessage(compileErr) || "Workflow saved but cannot be compiled");
      }
    } catch (err) {
      const message = getErrorMessage(err) || "Failed to save workflow";
      setValidationError(message);
      addToast(message, "error");
    } finally {
      setSaving(false);
    }
  }, [activeWorkflow, nodes, edges, projectId, addToast]);

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null;
  const overlayProps = useOverlayDismiss(onClose);

  return (
    <div className="modal-overlay wf-editor-overlay" {...overlayProps}>
      <div className="modal wf-editor-modal" ref={modalRef} onClick={(e) => e.stopPropagation()}>
        <header className="wf-editor-header">
          <h2>Workflows</h2>
          <button className="wf-editor-close" onClick={onClose} aria-label="Close workflow editor">
            <X size={18} />
          </button>
        </header>

        <div className="wf-editor-body">
          <aside className="wf-editor-sidebar">
            <button className="wf-editor-new" onClick={handleCreateWorkflow}>
              <Plus size={14} /> New workflow
            </button>
            {loading ? (
              <div className="wf-editor-empty">
                <Loader2 size={16} className="wf-spin" /> Loading…
              </div>
            ) : workflows.length === 0 ? (
              <div className="wf-editor-empty">No workflows yet.</div>
            ) : (
              <ul className="wf-editor-list">
                {workflows.map((w) => (
                  <li key={w.id}>
                    <button
                      className={`wf-editor-list-item${w.id === activeId ? " active" : ""}`}
                      onClick={() => setActiveId(w.id)}
                    >
                      {w.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>

          <section className="wf-editor-canvas-wrap">
            {activeWorkflow ? (
              <>
                <div className="wf-editor-toolbar">
                  <div className="wf-editor-palette">
                    {PALETTE.map(({ kind, label, icon: Icon }) => (
                      <button key={kind} className="wf-palette-btn" onClick={() => addNode(kind)}>
                        <Icon size={13} /> {label}
                      </button>
                    ))}
                  </div>
                  <div className="wf-editor-actions">
                    <button className="wf-editor-delete" onClick={handleDeleteWorkflow}>
                      <Trash2 size={13} /> Delete
                    </button>
                    <button className="wf-editor-save" onClick={handleSave} disabled={saving}>
                      {saving ? <Loader2 size={13} className="wf-spin" /> : <Save size={13} />} Save
                    </button>
                  </div>
                </div>

                {validationError && (
                  <div className="wf-editor-banner" role="alert">
                    {validationError}
                  </div>
                )}

                <div className="wf-editor-canvas">
                  <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    nodeTypes={workflowNodeTypes}
                    onNodesChange={onNodesChange}
                    onEdgesChange={onEdgesChange}
                    onConnect={onConnect}
                    onNodeClick={(_, node) => setSelectedNodeId(node.id)}
                    onPaneClick={() => setSelectedNodeId(null)}
                    fitView
                  >
                    <Background />
                    <Controls />
                    <MiniMap pannable zoomable />
                  </ReactFlow>
                </div>
              </>
            ) : (
              <div className="wf-editor-empty wf-editor-canvas-empty">
                Select or create a workflow to start editing.
              </div>
            )}
          </section>

          {selectedNode && selectedNode.data.kind !== "start" && selectedNode.data.kind !== "end" && (
            <aside className="wf-editor-inspector">
              <h3>Node</h3>
              <label className="wf-field">
                <span>Name</span>
                <input
                  value={selectedNode.data.label}
                  onChange={(e) => updateSelectedData({ label: e.target.value })}
                />
              </label>

              {selectedNode.data.kind === "prompt" || selectedNode.data.kind === "gate" ? (
                <label className="wf-field">
                  <span>Prompt</span>
                  <textarea
                    rows={5}
                    value={String(selectedNode.data.config?.prompt ?? "")}
                    onChange={(e) => updateSelectedData({ config: { prompt: e.target.value } })}
                  />
                </label>
              ) : null}

              {selectedNode.data.kind === "script" ? (
                <label className="wf-field">
                  <span>Script name</span>
                  <input
                    value={String(selectedNode.data.config?.scriptName ?? "")}
                    onChange={(e) => updateSelectedData({ config: { scriptName: e.target.value } })}
                  />
                </label>
              ) : null}

              {selectedNode.data.kind !== "merge" ? (
                <label className="wf-field">
                  <span>Gate mode</span>
                  <select
                    // Default display must match the compiler's defaults:
                    // gate and script nodes block by default, prompt is advisory.
                    value={String(
                      selectedNode.data.config?.gateMode
                        ?? (selectedNode.data.kind === "prompt" ? "advisory" : "gate"),
                    )}
                    onChange={(e) => updateSelectedData({ config: { gateMode: e.target.value } })}
                  >
                    <option value="advisory">Advisory</option>
                    <option value="gate">Gate (blocks)</option>
                  </select>
                </label>
              ) : (
                <p className="wf-inspector-note">
                  Steps before this marker run pre-merge; steps after run post-merge.
                </p>
              )}
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}

export function WorkflowNodeEditor({ isOpen, ...rest }: WorkflowNodeEditorProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  useModalResizePersist(modalRef, isOpen, "fusion:workflow-node-editor-size");
  if (!isOpen) return null;
  return (
    <ReactFlowProvider>
      <InnerEditor {...rest} modalRef={modalRef} />
    </ReactFlowProvider>
  );
}
