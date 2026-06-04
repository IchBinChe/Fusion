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
import { useTranslation } from "react-i18next";
import { X, Plus, Trash2, Save, MessageSquare, Terminal, Shield, GitMerge, Loader2, HelpCircle, PauseCircle, Split, Merge } from "lucide-react";
import type { WorkflowDefinition, WorkflowIrColumn, TraitViolation } from "@fusion/core";
import { getErrorMessage } from "@fusion/core";
import {
  fetchWorkflows,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  compileWorkflow,
  fetchModels,
  fetchAgents,
  fetchDiscoveredSkills,
  type ModelInfo,
} from "../api";
import type { Agent } from "../api";
import type { DiscoveredSkill } from "../api";
import type { ToastType } from "../hooks/useToast";
import { useOverlayDismiss } from "../hooks/useOverlayDismiss";
import { useModalResizePersist } from "../hooks/useModalResizePersist";
import { workflowNodeTypes, type WorkflowFlowNodeData, type WorkflowEditorNodeKind } from "./nodes/WorkflowNodeTypes";
import {
  irToFlow,
  flowToIr,
  emptyWorkflowIr,
  emptyWorkflowLayout,
  columnsOf,
  columnsToBandNodes,
  strictColumnForY,
  validateColumnsClient,
  unplacedNodeIds,
  isColumnBandNode,
} from "./workflow-flow-mapping";
import { fetchTraits, type TraitCatalogEntry } from "../api";
import { WorkflowColumnPanel } from "./WorkflowColumnPanel";
import { CustomModelDropdown } from "./CustomModelDropdown";

type ExecutorKind = "model" | "agent" | "skill" | "cli";

// Mirror of @fusion/core's isBuiltinWorkflowId / BUILTIN_WORKFLOW_ID_PREFIX.
// Inlined because the dashboard app build aliases "@fusion/core" to its
// types-only entry (which doesn't re-export builtin-workflows), and importing
// the function would pull the eager BUILTIN_WORKFLOWS construction into the
// browser bundle for a one-line prefix check.
const isBuiltinWorkflowId = (id: string): boolean => id.startsWith("builtin:");

function getModelDropdownValue(provider: string, modelId: string): string {
  return provider && modelId ? `${provider}/${modelId}` : "";
}

function parseModelDropdownValue(value: string): { provider: string; modelId: string } {
  if (!value) return { provider: "", modelId: "" };
  const slashIndex = value.indexOf("/");
  if (slashIndex === -1) return { provider: "", modelId: "" };
  return { provider: value.slice(0, slashIndex), modelId: value.slice(slashIndex + 1) };
}

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

const PALETTE: Array<{ kind: WorkflowEditorNodeKind; label: string; icon: typeof MessageSquare; presetConfig?: Record<string, unknown> }> = [
  { kind: "prompt", label: "Prompt", icon: MessageSquare },
  { kind: "prompt", label: "User input", icon: HelpCircle, presetConfig: { awaitInput: true } },
  { kind: "script", label: "Script", icon: Terminal },
  { kind: "gate", label: "Gate", icon: Shield },
  { kind: "merge", label: "Merge boundary", icon: GitMerge },
  { kind: "hold", label: "Hold", icon: PauseCircle, presetConfig: { release: "manual" } },
  { kind: "split", label: "Split", icon: Split },
  { kind: "join", label: "Join", icon: Merge, presetConfig: { mode: "all", onBranchFailure: "collect" } },
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
  const { t } = useTranslation("app");
  // v2 columns the editor is authoring for the active workflow.
  const [columns, setColumns] = useState<WorkflowIrColumn[]>([]);
  const [traitCatalog, setTraitCatalog] = useState<TraitCatalogEntry[]>([]);

  const activeWorkflow = useMemo(() => workflows.find((w) => w.id === activeId), [workflows, activeId]);
  const isBuiltin = !!activeWorkflow && isBuiltinWorkflowId(activeWorkflow.id);

  // Trait catalog (for client-side composition validation; the panel fetches its
  // own copy for the picker, but the editor needs the flags to validate).
  useEffect(() => {
    let cancelled = false;
    fetchTraits(projectId)
      .then((catalog) => {
        if (!cancelled) setTraitCatalog(catalog);
      })
      .catch(() => {
        // Non-fatal: validation degrades to server-side parse on save.
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Composition violations (client mirror of validateColumnTraits).
  const columnViolations: TraitViolation[] = useMemo(
    () => (columns.length ? validateColumnsClient(columns, traitCatalog) : []),
    [columns, traitCatalog],
  );
  // Step nodes not placed in any column (v2 only).
  const unplaced = useMemo(() => unplacedNodeIds(nodes, columns), [nodes, columns]);
  const blockingViolationCount = columnViolations.filter((v) => v.severity === "error").length;

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
      setColumns([]);
      return;
    }
    const flow = irToFlow(activeWorkflow);
    setNodes(flow.nodes);
    setEdges(flow.edges);
    setColumns(columnsOf(activeWorkflow));
    setSelectedNodeId(null);
    setValidationError(null);
  }, [activeWorkflow, setNodes, setEdges]);

  // Server-reported node error (e.g. seam-in-branch) attributed to a node id.
  const [serverNodeError, setServerNodeError] = useState<{ nodeId: string; message: string } | null>(null);

  // Keep the swimlane band group nodes in sync with the authored columns
  // (add/rename/reorder via the column panel). Step nodes are preserved; only
  // the band nodes are replaced.
  useEffect(() => {
    setNodes((ns) => {
      const stepNodes = ns.filter((n) => !isColumnBandNode(n.id) && n.type !== "group");
      return [...columnsToBandNodes(columns), ...stepNodes];
    });
  }, [columns, setNodes]);

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((eds) =>
        addEdge({ ...connection, label: "success", data: { condition: "success" } }, eds),
      );
    },
    [setEdges],
  );

  // Dragging a step node into a column band sets node.column (position-based
  // hit testing against the ordered bands — see workflow-flow-mapping).
  const onNodeDragStop = useCallback(
    (_evt: unknown, node: FlowNode<WorkflowFlowNodeData>) => {
      if (isColumnBandNode(node.id) || columns.length === 0) return;
      // strictColumnForY (not the clamping columnForY): a node dragged above or
      // below all bands keeps no column rather than snapping to the nearest one.
      const column = strictColumnForY(node.position.y, columns);
      if (!column) return;
      setNodes((ns) =>
        ns.map((n) => (n.id === node.id ? { ...n, data: { ...n.data, column } } : n)),
      );
    },
    [columns, setNodes],
  );

  const addNode = useCallback(
    (kind: WorkflowEditorNodeKind, nodeLabel?: string, presetConfig?: Record<string, unknown>) => {
      const id = newNodeId();
      const label = nodeLabel ?? (kind === "merge" ? "Merge boundary" : kind.charAt(0).toUpperCase() + kind.slice(1));
      const baseConfig = kind === "gate" ? { gateMode: "gate" } : {};
      const config = presetConfig ? { ...baseConfig, ...presetConfig } : baseConfig;
      setNodes((ns) => [
        ...ns,
        {
          id,
          type: kind,
          position: { x: 200 + ns.length * 40, y: 240 + (ns.length % 3) * 70 },
          data: { kind, label, config },
          deletable: true,
        },
      ]);
      setSelectedNodeId(id);
    },
    [setNodes],
  );

  const updateSelectedData = useCallback(
    (
      patch:
        | Partial<WorkflowFlowNodeData>
        | {
            config:
              | Record<string, unknown>
              | ((prev: Record<string, unknown>) => Record<string, unknown>);
          },
    ) => {
      if (!selectedNodeId) return;
      setNodes((ns) =>
        ns.map((n) =>
          n.id === selectedNodeId
            ? {
                ...n,
                data: {
                  ...n.data,
                  ...("config" in patch
                    ? {
                        config:
                          typeof patch.config === "function"
                            ? patch.config((n.data.config ?? {}) as Record<string, unknown>)
                            : { ...(n.data.config ?? {}), ...patch.config },
                      }
                    : patch),
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
    if (isBuiltinWorkflowId(activeWorkflow.id)) return; // built-ins are read-only
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

  const handleDuplicate = useCallback(async () => {
    if (!activeWorkflow) return;
    try {
      const created = await createWorkflow(
        {
          name: `${activeWorkflow.name} (copy)`,
          description: activeWorkflow.description,
          ir: activeWorkflow.ir,
          layout: activeWorkflow.layout,
        },
        projectId,
      );
      setWorkflows((ws) => [...ws, created]);
      setActiveId(created.id);
      addToast(`Duplicated to "${created.name}" — editable`, "success");
    } catch (err) {
      addToast(getErrorMessage(err) || "Failed to duplicate workflow", "error");
    }
  }, [activeWorkflow, projectId, addToast]);

  const handleSave = useCallback(async () => {
    if (!activeWorkflow) return;
    if (isBuiltinWorkflowId(activeWorkflow.id)) return; // built-ins are read-only

    // Block save on client-detected violations before any round-trip:
    //  - unplaced step nodes (rendered as inline node badges + summary count);
    //  - trait composition errors (rendered on the offending column band).
    if (unplaced.length > 0) {
      const message = t(
        "workflowColumns.unplacedCount",
        "{{count}} nodes not placed in a column",
        { count: unplaced.length },
      );
      setValidationError(message);
      addToast(message, "error");
      return;
    }
    if (blockingViolationCount > 0) {
      const message = t(
        "workflowColumns.compositionBlocked",
        "Resolve trait conflicts on highlighted columns before saving",
      );
      setValidationError(message);
      addToast(message, "error");
      return;
    }

    setSaving(true);
    setValidationError(null);
    setServerNodeError(null);
    try {
      const { ir, layout } = flowToIr(activeWorkflow.name, nodes, edges, columns.length ? columns : undefined);
      const updated = await updateWorkflow(activeWorkflow.id, { ir, layout }, projectId);
      setWorkflows((ws) => ws.map((w) => (w.id === updated.id ? updated : w)));
      // Validate by compiling — surfaces non-linear graphs as a banner.
      try {
        await compileWorkflow(updated.id, projectId);
        addToast(t("workflows.saved", "Workflow saved"), "success");
      } catch (compileErr) {
        setValidationError(
          getErrorMessage(compileErr) || t("workflows.savedNotCompilable", "Workflow saved but cannot be compiled"),
        );
      }
    } catch (err) {
      const message = getErrorMessage(err) || t("workflows.saveFailed", "Failed to save workflow");
      // parseWorkflowIr (server) names the offending node for structural errors
      // like seam-in-branch ("seam 'merge' node 'n-…' is forbidden inside …").
      // Attribute it to that node so the shared error badge renders on it.
      const nodeMatch = /node '([^']+)'/.exec(message);
      if (nodeMatch && nodes.some((n) => n.id === nodeMatch[1])) {
        setServerNodeError({ nodeId: nodeMatch[1], message });
      }
      setValidationError(message);
      addToast(message, "error");
    } finally {
      setSaving(false);
    }
  }, [activeWorkflow, nodes, edges, columns, unplaced, blockingViolationCount, projectId, addToast, t]);

  // Stamp the shared error-state badge onto offending nodes: unplaced step
  // nodes and any node the server flagged (seam-in-branch). One component
  // (WorkflowNodeErrorBadge) renders both, keyed off data.errorBadge.
  const nodesForRender = useMemo(() => {
    const unplacedSet = new Set(unplaced);
    return nodes.map((n) => {
      let errorBadge: string | undefined;
      if (unplacedSet.has(n.id)) errorBadge = t("workflowColumns.nodeUnplaced", "Not placed in a column");
      if (serverNodeError?.nodeId === n.id) errorBadge = serverNodeError.message;
      if (errorBadge === n.data.errorBadge) return n;
      return { ...n, data: { ...n.data, errorBadge } };
    });
  }, [nodes, unplaced, serverNodeError, t]);

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null;

  // Lazy-loaded executor resources
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [skills, setSkills] = useState<DiscoveredSkill[]>([]);

  const currentExecutor = (selectedNode?.data.config?.executor as ExecutorKind | undefined) ?? "model";

  useEffect(() => {
    if (!selectedNode || (selectedNode.data.kind !== "prompt" && selectedNode.data.kind !== "gate")) return;
    if (currentExecutor === "model" && models.length === 0) {
      fetchModels().then((res) => setModels(res.models)).catch((err) => {
        addToast(getErrorMessage(err) || "Failed to load models", "error");
      });
    } else if (currentExecutor === "agent" && agents.length === 0) {
      fetchAgents().then(setAgents).catch((err) => {
        addToast(getErrorMessage(err) || "Failed to load agents", "error");
      });
    } else if (currentExecutor === "skill" && skills.length === 0) {
      fetchDiscoveredSkills(projectId).then(setSkills).catch((err) => {
        addToast(getErrorMessage(err) || "Failed to load skills", "error");
      });
    }
  }, [
    currentExecutor,
    selectedNode?.id,
    selectedNode?.data.kind,
    projectId,
    addToast,
    models.length,
    agents.length,
    skills.length,
  ]);

  const overlayProps = useOverlayDismiss(onClose);

  return (
    <div className="modal-overlay open wf-editor-overlay" {...overlayProps}>
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
                {isBuiltin ? (
                  // Read-only built-in: a banner *replaces* the save/edit toolbar
                  // (not an overlay); the canvas below stays inspectable.
                  <div className="wf-editor-readonly-banner" role="status" data-testid="wf-readonly-banner">
                    <span className="wf-editor-readonly-note">
                      {t("workflows.readOnlyBuiltin", "Read-only built-in workflow")}
                    </span>
                    <button className="wf-editor-save wf-editor-duplicate-primary" onClick={handleDuplicate}>
                      <Plus size={13} /> {t("workflows.duplicateToCustomize", "Duplicate to customize")}
                    </button>
                  </div>
                ) : (
                  <div className="wf-editor-toolbar">
                    <div className="wf-editor-palette">
                      {PALETTE.map(({ kind, label, icon: Icon, presetConfig }) => (
                        <button
                          key={label}
                          className="wf-palette-btn"
                          onClick={() => addNode(kind, label, presetConfig)}
                        >
                          <Icon size={13} /> {label}
                        </button>
                      ))}
                    </div>
                    <div className="wf-editor-actions">
                      <button className="wf-editor-delete" onClick={handleDeleteWorkflow}>
                        <Trash2 size={13} /> {t("common.delete", "Delete")}
                      </button>
                      <button className="wf-editor-save" onClick={handleSave} disabled={saving}>
                        {saving ? <Loader2 size={13} className="wf-spin" /> : <Save size={13} />}{" "}
                        {t("common.save", "Save")}
                      </button>
                    </div>
                  </div>
                )}

                {validationError && (
                  <div className="wf-editor-banner" role="alert">
                    {validationError}
                  </div>
                )}
                {unplaced.length > 0 && (
                  <div className="wf-editor-banner wf-editor-banner--warn" role="alert" data-testid="wf-unplaced-summary">
                    {t("workflowColumns.unplacedCount", "{{count}} nodes not placed in a column", {
                      count: unplaced.length,
                    })}
                  </div>
                )}

                <div className="wf-editor-canvas">
                  <ReactFlow
                    nodes={nodesForRender}
                    edges={edges}
                    nodeTypes={workflowNodeTypes}
                    onNodesChange={onNodesChange}
                    onEdgesChange={onEdgesChange}
                    onConnect={onConnect}
                    onNodeDragStop={onNodeDragStop}
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
                {t("workflows.selectOrCreate", "Select or create a workflow to start editing.")}
              </div>
            )}
          </section>

          {activeWorkflow && (
            <WorkflowColumnPanel
              columns={columns}
              onChange={setColumns}
              violations={columnViolations}
              readOnly={isBuiltin}
              projectId={projectId}
              addToast={addToast}
            />
          )}

          {selectedNode && selectedNode.data.kind !== "start" && selectedNode.data.kind !== "end" && (
            <aside className="wf-editor-inspector">
              <h3>Node</h3>
              {isBuiltin && (
                <p className="wf-inspector-note wf-inspector-note--info">
                  Read-only built-in — duplicate the workflow to edit nodes.
                </p>
              )}
              <fieldset className="wf-inspector-fields" disabled={isBuiltin}>
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

              {selectedNode.data.kind === "prompt" ? (
                <>
                  <label className="wf-field">
                    <span>Executor</span>
                    <select
                      value={currentExecutor}
                      onChange={(e) => updateSelectedData({ config: { executor: e.target.value } })}
                    >
                      <option value="model">Model</option>
                      <option value="agent">Agent</option>
                      <option value="skill">Skill</option>
                      <option value="cli">CLI / script</option>
                    </select>
                  </label>

                  {currentExecutor === "model" && (
                    <label className="wf-field">
                      <span>Model</span>
                      <CustomModelDropdown
                        label="Model"
                        models={models}
                        value={getModelDropdownValue(
                          String(selectedNode.data.config?.modelProvider ?? ""),
                          String(selectedNode.data.config?.modelId ?? ""),
                        )}
                        onChange={(value) => {
                          const { provider, modelId } = parseModelDropdownValue(value);
                          updateSelectedData({ config: { modelProvider: provider || undefined, modelId: modelId || undefined } });
                        }}
                      />
                    </label>
                  )}

                  {currentExecutor === "agent" && (
                    <label className="wf-field">
                      <span>Agent</span>
                      <select
                        value={String(selectedNode.data.config?.agentId ?? "")}
                        onChange={(e) => updateSelectedData({ config: { agentId: e.target.value || undefined } })}
                      >
                        <option value="">— select agent —</option>
                        {agents.map((a) => (
                          <option key={a.id} value={a.id}>{a.name}</option>
                        ))}
                      </select>
                    </label>
                  )}

                  {currentExecutor === "skill" && (
                    <label className="wf-field">
                      <span>Skill</span>
                      <select
                        value={String(selectedNode.data.config?.skillName ?? "")}
                        onChange={(e) => updateSelectedData({ config: { skillName: e.target.value || undefined } })}
                      >
                        <option value="">— select skill —</option>
                        {skills.map((s) => (
                          <option key={s.id} value={s.name}>{s.name}</option>
                        ))}
                      </select>
                    </label>
                  )}

                  {currentExecutor === "cli" && (
                    <>
                      <label className="wf-field">
                        <span>CLI mode</span>
                        <select
                          value={String(selectedNode.data.config?.cliMode ?? "command")}
                          onChange={(e) => updateSelectedData({ config: { cliMode: e.target.value } })}
                        >
                          <option value="command">Command</option>
                          <option value="script">Named script</option>
                        </select>
                      </label>
                      {(selectedNode.data.config?.cliMode ?? "command") === "command" ? (
                        <label className="wf-field">
                          <span>Command</span>
                          <textarea
                            rows={3}
                            placeholder="npm test -- --runInBand"
                            value={String(selectedNode.data.config?.cliCommand ?? "")}
                            onChange={(e) => updateSelectedData({ config: { cliCommand: e.target.value } })}
                          />
                          <p className="wf-inspector-note wf-inspector-note--info">
                            Runs an arbitrary command in the task worktree. The first time this exact command runs, the task pauses for your approval. The node prompt is passed via FUSION_NODE_PROMPT.
                          </p>
                          <label className="wf-field wf-field--checkbox">
                            <input
                              type="checkbox"
                              checked={selectedNode.data.config?.cliSkipApproval === true}
                              onChange={(e) => updateSelectedData({ config: { cliSkipApproval: e.target.checked } })}
                            />
                            <span>Skip first-run approval (runs without pausing)</span>
                          </label>
                        </label>
                      ) : (
                        <label className="wf-field">
                          <span>Script name</span>
                          <input
                            value={String(selectedNode.data.config?.scriptName ?? "")}
                            onChange={(e) => updateSelectedData({ config: { scriptName: e.target.value } })}
                          />
                          <span className="wf-inspector-note">Named script from project settings. The node prompt is passed via FUSION_NODE_PROMPT.</span>
                        </label>
                      )}
                    </>
                  )}

                  <label className="wf-field wf-field--checkbox">
                    <input
                      type="checkbox"
                      checked={Boolean(selectedNode.data.config?.autoApprove)}
                      onChange={(e) => updateSelectedData({ config: { autoApprove: e.target.checked } })}
                    />
                    <span>Auto-approve requests</span>
                  </label>
                  {Boolean(selectedNode.data.config?.autoApprove) && (
                    <p className="wf-inspector-note">
                      Runs without pausing for approval — e.g. a CLI command executes on its first run without waiting for your sign-off.
                    </p>
                  )}

                  <label className="wf-field">
                    <span>Max retries</span>
                    <input
                      type="number"
                      min={1}
                      max={10}
                      placeholder="default"
                      value={selectedNode.data.config?.maxRetries != null ? String(selectedNode.data.config.maxRetries) : ""}
                      onChange={(e) => {
                        const val = e.target.value.trim();
                        if (val === "") {
                          updateSelectedData({
                            config: (prev) => {
                              const next = { ...prev };
                              delete next.maxRetries;
                              return next;
                            },
                          });
                        } else {
                          const num = parseInt(val, 10);
                          if (!isNaN(num)) updateSelectedData({ config: { maxRetries: num } });
                        }
                      }}
                    />
                  </label>

                  <label className="wf-field wf-field--checkbox">
                    <input
                      type="checkbox"
                      checked={Boolean(selectedNode.data.config?.awaitInput)}
                      onChange={(e) => updateSelectedData({ config: { awaitInput: e.target.checked } })}
                    />
                    <span>Wait for user input</span>
                  </label>
                  {Boolean(selectedNode.data.config?.awaitInput) && (
                    <p className="wf-inspector-note wf-inspector-note--info">
                      This node pauses the task until you reply in the task's comments and unpause. The Prompt field above is shown to the user as the question.
                    </p>
                  )}
                </>
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

              {selectedNode.data.kind === "hold" ? (
                <label className="wf-field">
                  <span>{t("workflowNodes.releaseCondition", "Release condition")}</span>
                  <select
                    value={String(selectedNode.data.config?.release ?? "manual")}
                    onChange={(e) => updateSelectedData({ config: { release: e.target.value } })}
                  >
                    <option value="manual">{t("workflowNodes.releaseManual", "Manual promote")}</option>
                    <option value="timer">{t("workflowNodes.releaseTimer", "Timer")}</option>
                    <option value="capacity">{t("workflowNodes.releaseCapacity", "Downstream capacity")}</option>
                    <option value="dependency">{t("workflowNodes.releaseDependency", "Dependency complete")}</option>
                    <option value="external-event">{t("workflowNodes.releaseExternal", "External event")}</option>
                  </select>
                </label>
              ) : null}

              {selectedNode.data.kind === "join" ? (
                <>
                  <label className="wf-field">
                    <span>{t("workflowNodes.joinMode", "Join mode")}</span>
                    <select
                      value={(() => {
                        const m = selectedNode.data.config?.mode as unknown;
                        if (m && typeof m === "object" && "quorum" in (m as object)) return "quorum";
                        return typeof m === "string" ? m : "all";
                      })()}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === "quorum") {
                          updateSelectedData({ config: { mode: { quorum: 2 } } });
                        } else {
                          updateSelectedData({ config: { mode: v } });
                        }
                      }}
                    >
                      <option value="all">{t("workflowNodes.joinAll", "All branches")}</option>
                      <option value="any">{t("workflowNodes.joinAny", "Any branch")}</option>
                      <option value="quorum">{t("workflowNodes.joinQuorum", "Quorum (n)")}</option>
                    </select>
                  </label>
                  {(() => {
                    const m = selectedNode.data.config?.mode as unknown;
                    return m && typeof m === "object" && "quorum" in (m as object);
                  })() && (
                    <label className="wf-field">
                      <span>{t("workflowNodes.quorumN", "Quorum count (n)")}</span>
                      <input
                        type="number"
                        min={1}
                        value={String((selectedNode.data.config?.mode as { quorum?: number })?.quorum ?? 2)}
                        onChange={(e) => {
                          const n = parseInt(e.target.value, 10);
                          if (!isNaN(n)) updateSelectedData({ config: { mode: { quorum: n } } });
                        }}
                      />
                    </label>
                  )}
                  <label className="wf-field">
                    <span>{t("workflowNodes.failurePolicy", "On branch failure")}</span>
                    <select
                      value={String(selectedNode.data.config?.onBranchFailure ?? "collect")}
                      onChange={(e) => updateSelectedData({ config: { onBranchFailure: e.target.value } })}
                    >
                      <option value="collect">{t("workflowNodes.failureCollect", "Collect (wait for all)")}</option>
                      <option value="fail-fast">{t("workflowNodes.failureFailFast", "Fail-fast (cancel siblings)")}</option>
                    </select>
                  </label>
                </>
              ) : null}

              {selectedNode.data.kind === "split" ? (
                <p className="wf-inspector-note wf-inspector-note--info">
                  {t(
                    "workflowNodes.splitNote",
                    "Branches run concurrently from this node. Execute and merge seams are not allowed inside a branch.",
                  )}
                </p>
              ) : null}

              {selectedNode.data.kind === "prompt" ||
              selectedNode.data.kind === "gate" ||
              selectedNode.data.kind === "script" ? (
                <label className="wf-field">
                  <span>{t("workflowNodes.gateMode", "Gate mode")}</span>
                  <select
                    // Default display must match the compiler's defaults:
                    // gate and script nodes block by default, prompt is advisory.
                    value={String(
                      selectedNode.data.config?.gateMode
                        ?? (selectedNode.data.kind === "prompt" ? "advisory" : "gate"),
                    )}
                    onChange={(e) => updateSelectedData({ config: { gateMode: e.target.value } })}
                  >
                    <option value="advisory">{t("workflowNodes.advisory", "Advisory")}</option>
                    <option value="gate">{t("workflowNodes.gateBlocks", "Gate (blocks)")}</option>
                  </select>
                </label>
              ) : selectedNode.data.kind === "merge" ? (
                <p className="wf-inspector-note">
                  {t(
                    "workflowNodes.mergeBoundaryNote",
                    "Steps before this marker run pre-merge; steps after run post-merge.",
                  )}
                </p>
              ) : null}
              </fieldset>
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
