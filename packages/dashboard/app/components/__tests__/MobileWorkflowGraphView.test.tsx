import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MobileWorkflowGraphView } from "../MobileWorkflowGraphView";
import type { MobileWorkflowNodeSummary } from "../workflow-mobile-graph";

const rows: MobileWorkflowNodeSummary[] = [
  {
    id: "start",
    label: "Start",
    kind: "start",
    summary: "",
    editable: false,
    outgoing: [{ id: "e1", source: "start", target: "prompt", targetLabel: "Prompt", label: "success" }],
    children: [],
  },
  {
    id: "loop",
    label: "Review loop",
    kind: "loop",
    summary: "3x",
    editable: true,
    outgoing: [],
    children: [
      {
        id: "loop::child",
        label: "Loop step",
        kind: "prompt",
        summary: "Not configured",
        editable: true,
        parentId: "loop",
        templateLocalId: "child",
        outgoing: [],
        children: [],
      },
    ],
  },
];

describe("MobileWorkflowGraphView", () => {
  it("renders graph rows and selects nodes and edges", () => {
    const onSelectNode = vi.fn();
    const onSelectEdge = vi.fn();
    render(
      <MobileWorkflowGraphView
        rows={rows}
        selectedNodeId={null}
        selectedEdgeId={null}
        onSelectNode={onSelectNode}
        onSelectEdge={onSelectEdge}
      />,
    );

    fireEvent.click(within(screen.getByTestId("mobile-wf-node-start")).getByRole("button", { name: /start/i }));
    expect(onSelectNode).toHaveBeenCalledWith("start");

    fireEvent.click(screen.getByTestId("mobile-wf-edge-e1"));
    expect(onSelectEdge).toHaveBeenCalledWith("e1");
  });

  it("expands grouped template children", () => {
    render(
      <MobileWorkflowGraphView
        rows={rows}
        selectedNodeId="loop"
        selectedEdgeId={null}
        onSelectNode={() => {}}
        onSelectEdge={() => {}}
      />,
    );

    expect(screen.getByTestId("mobile-wf-node-loop::child")).toBeInTheDocument();
    fireEvent.click(within(screen.getByTestId("mobile-wf-node-loop")).getByRole("button", { name: /collapse/i }));
    expect(screen.queryByTestId("mobile-wf-node-loop::child")).not.toBeInTheDocument();
  });
});
