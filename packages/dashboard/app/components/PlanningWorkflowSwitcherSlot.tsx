import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { WorkflowSwitcher } from "./WorkflowSwitcher";
import type { WorkflowStatusCounts } from "./workflowStatusCounts";
import { useBoardWorkflows } from "../hooks/useBoardWorkflows";
import { useViewportMode } from "../hooks/useViewportMode";

/*
FNXC:PlanningWorkflowSwitcher 2026-06-22-00:00:
The Planning view must surface the SAME workflow dropdown as the Board, in the SAME location (the Header `#header-workflow-slot`). Board owns its own switcher only while the board is active, so Planning needs a self-contained mirror that tracks local selection and portals the identical `board-workflow-toolbar > board-workflow-selector > WorkflowSwitcher` markup into the header slot. We intentionally do NOT import Board (the board switcher is tied to board lifecycle/state).

FNXC:Workflows 2026-06-22-17:00:
The board-workflows fetch/cache/SSE-refresh path (refresh on mount, visibility/focus, and `workflow:created|updated|deleted` SSE, sequence-guarded and session-cached) now lives in the shared `useBoardWorkflows` hook used by Board too. This slot keeps only its header-portal poll and the render gate: only show when there is something to switch (workflow mode on AND >= 2 workflow options).
*/

interface PlanningWorkflowSwitcherSlotProps {
  projectId?: string;
  onOpenWorkflowEditor?: () => void;
  onCreateWorkflow?: () => void;
}

// Counts require live task/column data that Planning does not thread here.
// WorkflowSwitcher renders zero counts for an empty map, so pass a stable empty Map
// rather than threading tasks into the Planning view.
const EMPTY_COUNTS: Map<string, WorkflowStatusCounts> = new Map();

export function PlanningWorkflowSwitcherSlot({ projectId, onOpenWorkflowEditor, onCreateWorkflow }: PlanningWorkflowSwitcherSlotProps) {
  const {
    workflowMode,
    workflowOptions,
    selectedWorkflow,
    setSelectedWorkflowId,
    refreshBoardWorkflows,
  } = useBoardWorkflows({ projectId });
  const viewportMode = useViewportMode();

  // Header may mount its workflow slot after this component, so resolve it on mount
  // and re-resolve via a short polling effect until it attaches. Render only via portal.
  const [headerWorkflowSlot, setHeaderWorkflowSlot] = useState<HTMLElement | null>(() => {
    if (typeof document === "undefined") return null;
    return document.getElementById("header-workflow-slot");
  });

  // Attach to the header slot once the Header mounts it. Poll briefly until present.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const resolve = () => {
      const slot = document.getElementById("header-workflow-slot");
      setHeaderWorkflowSlot((prev) => (prev === slot ? prev : slot));
      return slot;
    };
    if (resolve()) return;
    /*
    FNXC:PlanningWorkflowSwitcher 2026-06-23-20:05:
    Header swaps the workflow portal slot between mobile and non-mobile placements as the viewport changes. Re-resolve the DOM node on viewport-mode changes and cap polling so the Planning selector never stays attached to a removed slot after resizing.
    */
    let attempts = 0;
    const interval = window.setInterval(() => {
      attempts += 1;
      if (resolve() || attempts >= 20) window.clearInterval(interval);
    }, 250);
    return () => window.clearInterval(interval);
  }, [viewportMode]);

  // Gate: only render when there is something to switch (>= 2 options), matching Board's "show only when switchable" intent.
  if (!workflowMode || !selectedWorkflow || workflowOptions.length < 2 || !headerWorkflowSlot) {
    return null;
  }

  const workflowToolbar = (
    <div className="board-workflow-toolbar">
      <div className="board-workflow-selector">
        <WorkflowSwitcher
          workflows={workflowOptions}
          value={selectedWorkflow.id}
          onChange={setSelectedWorkflowId}
          counts={EMPTY_COUNTS}
          onOpen={refreshBoardWorkflows}
          onEditWorkflow={onOpenWorkflowEditor}
          onCreateWorkflow={onCreateWorkflow}
        />
      </div>
    </div>
  );

  return createPortal(workflowToolbar, headerWorkflowSlot);
}
