import { ChevronDown, ChevronRight, GitBranch, Pencil } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { MobileWorkflowNodeSummary } from "./workflow-mobile-graph";
import "./MobileWorkflowGraphView.css";

interface MobileWorkflowGraphViewProps {
  rows: MobileWorkflowNodeSummary[];
  selectedNodeId?: string | null;
  selectedEdgeId?: string | null;
  onSelectNode: (id: string) => void;
  onSelectEdge: (id: string) => void;
}

function NodeRow({
  row,
  depth,
  selectedNodeId,
  selectedEdgeId,
  onSelectNode,
  onSelectEdge,
}: {
  row: MobileWorkflowNodeSummary;
  depth: number;
  selectedNodeId?: string | null;
  selectedEdgeId?: string | null;
  onSelectNode: (id: string) => void;
  onSelectEdge: (id: string) => void;
}) {
  const { t } = useTranslation("app");
  const hasChildren = row.children.length > 0;
  const [expanded, setExpanded] = useState(depth === 0);
  const selected = selectedNodeId === row.id;

  return (
    <div className="mobile-wf-node-group">
      <div
        className={`mobile-wf-node-row${selected ? " mobile-wf-node-row--selected" : ""}`}
        style={{ ["--mobile-wf-depth" as string]: String(depth) }}
        data-testid={`mobile-wf-node-${row.id}`}
      >
        <button
          type="button"
          className="mobile-wf-node-main"
          onClick={() => onSelectNode(row.id)}
          aria-current={selected ? "true" : undefined}
        >
          <span className="mobile-wf-node-kind">{row.kind}</span>
          <span className="mobile-wf-node-text">
            <span className="mobile-wf-node-title">{row.label}</span>
            {row.summary ? <span className="mobile-wf-node-summary">{row.summary}</span> : null}
          </span>
          {row.editable ? <Pencil size={14} aria-hidden /> : null}
        </button>
        {hasChildren ? (
          <button
            type="button"
            className="mobile-wf-node-expand"
            aria-expanded={expanded}
            aria-label={expanded ? t("common.collapse", "Collapse") : t("common.expand", "Expand")}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
        ) : null}
      </div>
      {(row.columnName || row.outgoing.length > 0) && (
        <div
          className="mobile-wf-node-meta"
          style={{ ["--mobile-wf-depth" as string]: String(depth) }}
        >
          {row.columnName ? <span className="mobile-wf-column-chip">{row.columnName}</span> : null}
          {row.outgoing.map((edge) => (
            <button
              key={edge.id}
              type="button"
              className={`mobile-wf-edge-chip${selectedEdgeId === edge.id ? " mobile-wf-edge-chip--selected" : ""}`}
              data-testid={`mobile-wf-edge-${edge.id}`}
              onClick={() => onSelectEdge(edge.id)}
            >
              <GitBranch size={12} aria-hidden />
              <span>{edge.label}</span>
              <span className="mobile-wf-edge-target">{edge.targetLabel}</span>
            </button>
          ))}
        </div>
      )}
      {hasChildren && expanded ? (
        <div className="mobile-wf-node-children">
          {row.children.map((child) => (
            <NodeRow
              key={child.id}
              row={child}
              depth={depth + 1}
              selectedNodeId={selectedNodeId}
              selectedEdgeId={selectedEdgeId}
              onSelectNode={onSelectNode}
              onSelectEdge={onSelectEdge}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function MobileWorkflowGraphView({
  rows,
  selectedNodeId,
  selectedEdgeId,
  onSelectNode,
  onSelectEdge,
}: MobileWorkflowGraphViewProps) {
  const { t } = useTranslation("app");
  if (rows.length === 0) {
    return (
      <div className="mobile-wf-graph-empty" data-testid="mobile-wf-graph-empty">
        {t("workflowNodes.mobileGraphEmpty", "No graph nodes yet.")}
      </div>
    );
  }

  return (
    <div className="mobile-wf-graph" data-testid="mobile-wf-graph">
      {rows.map((row) => (
        <NodeRow
          key={row.id}
          row={row}
          depth={0}
          selectedNodeId={selectedNodeId}
          selectedEdgeId={selectedEdgeId}
          onSelectNode={onSelectNode}
          onSelectEdge={onSelectEdge}
        />
      ))}
    </div>
  );
}
