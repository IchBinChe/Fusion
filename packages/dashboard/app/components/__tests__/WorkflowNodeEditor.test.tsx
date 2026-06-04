import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import type { WorkflowDefinition } from "@fusion/core";
import { irToFlow, flowToIr, emptyWorkflowIr, emptyWorkflowLayout } from "../workflow-flow-mapping";

vi.mock("../../api", () => ({
  fetchWorkflows: vi.fn(),
  createWorkflow: vi.fn(),
  updateWorkflow: vi.fn(),
  deleteWorkflow: vi.fn(),
  compileWorkflow: vi.fn(),
  fetchTraits: vi.fn(),
  fetchModels: vi.fn(),
  fetchAgents: vi.fn(),
  fetchDiscoveredSkills: vi.fn(),
}));

import { fireEvent } from "@testing-library/react";
import { fetchWorkflows, fetchTraits, updateWorkflow, compileWorkflow, createWorkflow } from "../../api";
import type { TraitCatalogEntry } from "../../api";
import { WorkflowNodeEditor } from "../WorkflowNodeEditor";

const TRAIT_CATALOG: TraitCatalogEntry[] = [
  { id: "intake", name: "Intake", builtin: true, flags: { intake: true } },
  { id: "complete", name: "Complete", builtin: true, flags: { complete: true } },
  { id: "wip", name: "WIP", builtin: true, flags: { countsTowardWip: true } },
  { id: "hold", name: "Hold", builtin: true, flags: { hold: true } },
];

function v2Def(): WorkflowDefinition {
  return {
    id: "WF-002",
    name: "Custom",
    description: "",
    ir: {
      version: "v2",
      name: "Custom",
      columns: [
        { id: "triage", name: "Triage", traits: [{ trait: "intake" }] },
        { id: "done", name: "Done", traits: [{ trait: "complete" }] },
      ],
      nodes: [
        { id: "start", kind: "start", column: "triage" },
        { id: "step", kind: "prompt", column: "triage", config: { prompt: "do" } },
        { id: "end", kind: "end", column: "done" },
      ],
      edges: [
        { from: "start", to: "step", condition: "success" },
        { from: "step", to: "end", condition: "success" },
      ],
    },
    layout: {
      start: { x: 0, y: 20 },
      step: { x: 120, y: 60 },
      end: { x: 360, y: 240 },
    },
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
  };
}

function builtinDef(): WorkflowDefinition {
  const d = v2Def();
  return { ...d, id: "builtin:coding", name: "Default coding workflow" };
}

function def(): WorkflowDefinition {
  return {
    id: "WF-001",
    name: "QA",
    description: "",
    ir: {
      version: "v1",
      name: "QA",
      nodes: [
        { id: "start", kind: "start" },
        { id: "lint", kind: "gate", config: { name: "Lint", scriptName: "lint", gateMode: "gate" } },
        { id: "merge", kind: "prompt", config: { seam: "merge", name: "Merge boundary" } },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "lint", condition: "success" },
        { from: "lint", to: "merge", condition: "success" },
        { from: "merge", to: "end", condition: "success" },
      ],
    },
    layout: { start: { x: 0, y: 0 }, lint: { x: 120, y: 0 }, merge: { x: 240, y: 0 }, end: { x: 360, y: 0 } },
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
  };
}

describe("workflow-flow-mapping", () => {
  it("round-trips IR through flow and back, preserving structure and layout", () => {
    const original = def();
    const flow = irToFlow(original);
    expect(flow.nodes).toHaveLength(4);
    expect(flow.nodes.find((n) => n.id === "lint")?.type).toBe("gate");
    expect(flow.nodes.find((n) => n.id === "merge")?.type).toBe("merge");
    expect(flow.nodes.find((n) => n.id === "start")?.position).toEqual({ x: 0, y: 0 });

    const { ir, layout } = flowToIr(original.name, flow.nodes, flow.edges);
    expect(ir.nodes.map((n) => n.id)).toEqual(["start", "lint", "merge", "end"]);
    // merge marker maps back to a prompt node carrying the seam config.
    const mergeNode = ir.nodes.find((n) => n.id === "merge");
    expect(mergeNode?.kind).toBe("prompt");
    expect(mergeNode?.config?.seam).toBe("merge");
    expect(ir.edges).toHaveLength(3);
    expect(layout.lint).toEqual({ x: 120, y: 0 });
  });

  it("emptyWorkflowIr seeds a connected start→end graph", () => {
    const ir = emptyWorkflowIr("New");
    expect(ir.nodes.map((n) => n.kind)).toEqual(["start", "end"]);
    expect(ir.edges).toEqual([{ from: "start", to: "end", condition: "success" }]);
    expect(emptyWorkflowLayout().start).toBeDefined();
  });
});

describe("WorkflowNodeEditor", () => {
  beforeEach(() => {
    vi.mocked(fetchWorkflows).mockResolvedValue([]);
    vi.mocked(fetchTraits).mockResolvedValue(TRAIT_CATALOG);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders the empty state when there are no workflows (no canvas)", async () => {
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    expect(await screen.findByText("Workflows")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/No workflows yet/i)).toBeInTheDocument());
    expect(screen.getByText(/Select or create a workflow/i)).toBeInTheDocument();
  });

  it("renders nothing when closed", () => {
    const { container } = render(<WorkflowNodeEditor isOpen={false} onClose={() => {}} addToast={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("WorkflowNodeEditor — U10 columns/traits/holds", () => {
  beforeEach(() => {
    vi.mocked(fetchTraits).mockResolvedValue(TRAIT_CATALOG);
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows the column panel with the workflow's columns and trait pickers", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    expect(await screen.findByTestId("wf-column-panel")).toBeInTheDocument();
    expect(await screen.findByTestId("wf-column-triage")).toBeInTheDocument();
    expect(screen.getByTestId("wf-column-done")).toBeInTheDocument();
    // Trait picker fed by the catalog endpoint.
    await waitFor(() => expect(screen.getAllByText("Complete").length).toBeGreaterThan(0));
  });

  it("blocks save with a count summary when a node is unplaced", async () => {
    const addToast = vi.fn();
    // A def whose 'step' node sits far below all bands → unplaced.
    const d = v2Def();
    d.layout = { ...d.layout, step: { x: 120, y: 5000 } };
    // Strip the explicit column so placement is position-derived.
    if (d.ir.version === "v2") d.ir.nodes = d.ir.nodes.map((n) => (n.id === "step" ? { ...n, column: undefined } : n));
    vi.mocked(fetchWorkflows).mockResolvedValue([d]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={addToast} />);
    const saveBtn = await screen.findByText("Save");
    await waitFor(() => expect(screen.getByTestId("wf-unplaced-summary")).toBeInTheDocument());
    fireEvent.click(saveBtn.closest("button")!);

    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith(expect.stringMatching(/not placed in a column/i), "error"),
    );
    expect(updateWorkflow).not.toHaveBeenCalled();
    // Inline node badge present.
    expect(screen.getByTestId("wf-node-error-badge")).toBeInTheDocument();
  });

  it("renders a trait conflict on the column and blocks save", async () => {
    const addToast = vi.fn();
    const d = v2Def();
    // Make 'done' both complete and wip — a composition conflict.
    if (d.ir.version === "v2") {
      d.ir.columns = d.ir.columns.map((c) =>
        c.id === "done" ? { ...c, traits: [{ trait: "complete" }, { trait: "wip" }] } : c,
      );
    }
    vi.mocked(fetchWorkflows).mockResolvedValue([d]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={addToast} />);
    const doneCol = await screen.findByTestId("wf-column-done");
    await waitFor(() => expect(doneCol).toHaveAttribute("data-column-error", "true"));

    fireEvent.click((await screen.findByText("Save")).closest("button")!);
    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith(expect.stringMatching(/trait conflicts/i), "error"),
    );
    expect(updateWorkflow).not.toHaveBeenCalled();
  });

  it("surfaces a seam-in-branch server error as a node badge", async () => {
    const addToast = vi.fn();
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);
    vi.mocked(updateWorkflow).mockRejectedValue(
      new Error("seam 'merge' node 'step' is forbidden inside a parallel branch of split 's1'"),
    );

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={addToast} />);
    fireEvent.click((await screen.findByText("Save")).closest("button")!);

    await waitFor(() => expect(updateWorkflow).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByTestId("wf-node-error-badge")).toHaveTextContent(/forbidden inside a parallel branch/i),
    );
  });

  it("opens a built-in read-only with a Duplicate to customize CTA replacing the toolbar", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([builtinDef()]);
    vi.mocked(createWorkflow).mockResolvedValue({ ...v2Def(), id: "WF-copy", name: "Copy" });

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    expect(await screen.findByTestId("wf-readonly-banner")).toBeInTheDocument();
    // No Save button (toolbar replaced).
    expect(screen.queryByText("Save")).not.toBeInTheDocument();
    const dup = screen.getByText(/Duplicate to customize/i);
    expect(dup).toBeInTheDocument();
    fireEvent.click(dup.closest("button")!);
    await waitFor(() => expect(createWorkflow).toHaveBeenCalled());
  });

  it("saves a valid v2 workflow round-tripping columns to the API", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);
    vi.mocked(updateWorkflow).mockImplementation(async (_id, updates) => ({
      ...v2Def(),
      ...(updates as object),
    }));
    vi.mocked(compileWorkflow).mockResolvedValue({ steps: [] });

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    // Wait for the column panel to hydrate before saving — saving earlier
    // races the async columns state and flowToIr would emit a v1 IR.
    await screen.findByText("Save");
    await waitFor(() => expect(screen.getAllByLabelText(/Column name/i).length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("Save").closest("button")!);

    await waitFor(() => expect(updateWorkflow).toHaveBeenCalled());
    const [, updates] = vi.mocked(updateWorkflow).mock.calls[0];
    expect((updates as { ir: { version: string } }).ir.version).toBe("v2");
    expect((updates as { ir: { columns: unknown[] } }).ir.columns).toHaveLength(2);
  });
});
