import { useEffect, useMemo, useRef } from "react";
import type { Task } from "@fusion/core";
import { GraphTaskNode } from "./GraphTaskNode";
import { GraphToolbar } from "./GraphToolbar";
import { GraphEdges } from "./edges";
import { filterGraphTasks } from "./filters";
import { computeAutoLayout } from "./layout";
import { useGraphData } from "./useGraphData";
import { useGraphInteraction } from "./useGraphInteraction";
import "./DependencyGraph.css";

const NODE_WIDTH = 280;
const NODE_HEIGHT = 100;
const POSITION_STORAGE_KEY = "fusion-plugin-dependency-graph:positions";

function getScopedPositionItem(projectId?: string): string | null {
  if (typeof window === "undefined") return null;
  if (typeof window.localStorage?.getItem !== "function") return null;
  const key = projectId ? `kb:${projectId}:${POSITION_STORAGE_KEY}` : POSITION_STORAGE_KEY;
  return window.localStorage.getItem(key);
}

export interface DependencyGraphProps {
  tasks: Task[];
  projectId?: string;
  onOpenTaskDetail?: (taskId: string) => void;
  onOpenDetail?: (task: Task) => void;
  addToast?: (message: string, type?: "success" | "error" | "info" | "warning") => void;
  globalPaused?: boolean;
  onUpdateTask?: (id: string, updates: { title?: string; description?: string; dependencies?: string[] }) => Promise<Task>;
  onArchiveTask?: (id: string) => Promise<Task>;
  onUnarchiveTask?: (id: string) => Promise<Task>;
  onDeleteTask?: (id: string, options?: { removeDependencyReferences?: boolean }) => Promise<Task>;
  onRetryTask?: (id: string) => Promise<Task>;
  onOpenDetailWithTab?: (task: Task, initialTab: "changes") => void;
  taskStuckTimeoutMs?: number;
  onOpenMission?: (missionId: string) => void;
  onMoveTask?: (id: string, column: Task["column"], optionsOrPosition?: { preserveProgress?: boolean } | number) => Promise<Task>;
  lastFetchTimeMs?: number;
  workflowStepNameLookup?: ReadonlyMap<string, string>;
}

export function DependencyGraph({
  tasks,
  projectId,
  onOpenTaskDetail,
  onOpenDetail,
  addToast,
  globalPaused,
  onUpdateTask,
  onArchiveTask,
  onUnarchiveTask,
  onDeleteTask,
  onRetryTask,
  onOpenDetailWithTab,
  taskStuckTimeoutMs,
  onOpenMission,
  onMoveTask,
  lastFetchTimeMs,
  workflowStepNameLookup,
}: DependencyGraphProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const initialFitDoneRef = useRef(false);
  const filteredTasks = useMemo(() => filterGraphTasks(tasks), [tasks]);
  const graphData = useGraphData(filteredTasks);
  const positions = useMemo(
    () => computeAutoLayout(graphData, { nodeWidth: NODE_WIDTH, nodeHeight: NODE_HEIGHT, horizontalGap: 40, verticalGap: 80 }),
    [graphData],
  );

  const {
    transform,
    zoom,
    transitioning,
    zoomIn,
    zoomOut,
    resetView,
    fitToGraph,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onWheelZoom,
    handleKeyDown,
  } = useGraphInteraction();

  useEffect(() => {
    if (initialFitDoneRef.current) return;
    if (filteredTasks.length === 0) return;

    const hasSavedPositions = Boolean(getScopedPositionItem(projectId));
    if (hasSavedPositions) {
      initialFitDoneRef.current = true;
      return;
    }

    const viewport = viewportRef.current;
    if (!viewport) return;

    fitToGraph(positions, viewport.clientWidth, viewport.clientHeight, { nodeWidth: NODE_WIDTH, nodeHeight: NODE_HEIGHT });
    initialFitDoneRef.current = true;
  }, [filteredTasks.length, fitToGraph, positions, projectId]);

  const bounds = useMemo(() => {
    const values = Array.from(positions.values());
    if (values.length === 0) return { width: 0, height: 0 };
    const maxX = Math.max(...values.map((pos) => pos.x + NODE_WIDTH));
    const maxY = Math.max(...values.map((pos) => pos.y + NODE_HEIGHT));
    return { width: maxX, height: maxY };
  }, [positions]);

  return (
    <section className="dependency-graph" data-testid="dependency-graph">
      <div
        ref={viewportRef}
        className="dependency-graph__viewport"
        onPointerDown={(event) => onPointerDown(event.pointerId, { x: event.clientX, y: event.clientY })}
        onPointerMove={(event) => {
          const viewport = viewportRef.current;
          if (!viewport) return;
          onPointerMove(event.pointerId, { x: event.clientX, y: event.clientY }, viewport.clientWidth, viewport.clientHeight);
        }}
        onPointerUp={(event) => onPointerUp(event.pointerId)}
        onPointerCancel={(event) => onPointerUp(event.pointerId)}
        onWheel={(event) => {
          event.preventDefault();
          const viewport = viewportRef.current;
          if (!viewport) return;
          const rect = viewport.getBoundingClientRect();
          onWheelZoom(event.deltaY, { x: event.clientX - rect.left, y: event.clientY - rect.top }, viewport.clientWidth, viewport.clientHeight);
        }}
        onKeyDown={(event) => {
          const viewport = viewportRef.current;
          if (!viewport) return;
          handleKeyDown(event, viewport.clientWidth, viewport.clientHeight, positions, { nodeWidth: NODE_WIDTH, nodeHeight: NODE_HEIGHT });
        }}
        tabIndex={0}
        style={{ outline: "none" }}
      >
        {filteredTasks.length === 0 ? (
          <div className="dependency-graph__empty">No active tasks to display in graph view.</div>
        ) : (
          <div className={`graph-canvas-transform${transitioning ? " graph-canvas-transform--animate" : ""}`} style={{ transform, width: `${bounds.width}px`, height: `${bounds.height}px` }}>
            <GraphEdges edges={graphData.edges} positions={positions} nodeWidth={NODE_WIDTH} nodeHeight={NODE_HEIGHT} />
            <div className="dependency-graph__nodes-layer">
              {graphData.nodes.map((node) => {
                const position = positions.get(node.task.id);
                if (!position) return null;

                return (
                  <GraphTaskNode
                    key={node.task.id}
                    task={node.task}
                    projectId={projectId}
                    style={{ minHeight: `${NODE_HEIGHT}px`, left: `${position.x}px`, top: `${position.y}px` }}
                    onOpenDetail={onOpenDetail ?? ((task) => onOpenTaskDetail?.(task.id))}
                    addToast={addToast ?? (() => {})}
                    globalPaused={globalPaused}
                    onUpdateTask={onUpdateTask}
                    onArchiveTask={onArchiveTask}
                    onUnarchiveTask={onUnarchiveTask}
                    onDeleteTask={onDeleteTask}
                    onRetryTask={onRetryTask}
                    onOpenDetailWithTab={onOpenDetailWithTab}
                    taskStuckTimeoutMs={taskStuckTimeoutMs}
                    onOpenMission={onOpenMission}
                    onMoveTask={onMoveTask}
                    lastFetchTimeMs={lastFetchTimeMs}
                    workflowStepNameLookup={workflowStepNameLookup}
                  />
                );
              })}
            </div>
          </div>
        )}
      </div>

      <GraphToolbar
        zoom={zoom}
        onZoomIn={() => {
          const viewport = viewportRef.current;
          if (!viewport) return;
          zoomIn(viewport.clientWidth, viewport.clientHeight);
        }}
        onZoomOut={() => {
          const viewport = viewportRef.current;
          if (!viewport) return;
          zoomOut(viewport.clientWidth, viewport.clientHeight);
        }}
        onFitToGraph={() => {
          const viewport = viewportRef.current;
          if (!viewport) return;
          fitToGraph(positions, viewport.clientWidth, viewport.clientHeight, { nodeWidth: NODE_WIDTH, nodeHeight: NODE_HEIGHT });
        }}
        onResetView={resetView}
      />
    </section>
  );
}
