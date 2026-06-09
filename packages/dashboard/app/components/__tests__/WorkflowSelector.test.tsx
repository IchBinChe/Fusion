import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WorkflowSelector } from "../WorkflowSelector";
import { scopedKey } from "../../utils/projectStorage";

vi.mock("lucide-react", () => ({
  Workflow: () => null,
  ChevronDown: () => null,
  ChevronRight: () => null,
}));

const fetchWorkflowsMock = vi.fn();
const fetchWorkflowMock = vi.fn();
vi.mock("../../api", () => ({
  fetchWorkflows: (...args: unknown[]) => fetchWorkflowsMock(...args),
  fetchWorkflow: (...args: unknown[]) => fetchWorkflowMock(...args),
  fetchProjectDefaultWorkflow: vi.fn(),
  setProjectDefaultWorkflow: vi.fn(),
}));

const mockConfirm = vi.fn();
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirm: mockConfirm }) }));

beforeEach(() => {
  localStorage.clear();
  mockConfirm.mockReset();
  fetchWorkflowsMock.mockReset();
  fetchWorkflowMock.mockReset();
  fetchWorkflowsMock.mockResolvedValue([
    { id: "wf-a", name: "Workflow A" },
    { id: "wf-b", name: "Workflow B" },
  ]);
  fetchWorkflowMock.mockResolvedValue({ id: "builtin:hidden", name: "Hidden built-in" });
});

describe("WorkflowSelector collapsible mode", () => {
  const storageKey = "kb-board-workflow-selector-collapsed";

  it("defaults to expanded when no persisted collapsed state exists", async () => {
    render(<WorkflowSelector value={null} onChange={vi.fn()} collapsible collapseStorageKey={storageKey} projectId="project-a" />);

    expect(screen.getByRole("button", { name: /Collapse workflow selector/i })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("combobox", { name: /Workflow/i })).toBeDefined();
    await waitFor(() => expect(screen.getByRole("option", { name: "Workflow A" })).toBeDefined());
  });

  it("collapses and expands while persisting state by project", async () => {
    render(<WorkflowSelector value={null} onChange={vi.fn()} collapsible collapseStorageKey={storageKey} projectId="project-a" />);

    fireEvent.click(screen.getByRole("button", { name: /Collapse workflow selector/i }));

    expect(screen.getByRole("button", { name: /^Workflow$/i })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(localStorage.getItem(scopedKey(storageKey, "project-a"))).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: /^Workflow$/i }));

    expect(screen.getByRole("combobox", { name: /Workflow/i })).toBeDefined();
    expect(localStorage.getItem(scopedKey(storageKey, "project-a"))).toBe("false");
  });

  it("restores persisted collapsed state for the current project only", () => {
    localStorage.setItem(scopedKey(storageKey, "project-a"), "true");

    const { rerender } = render(
      <WorkflowSelector value={null} onChange={vi.fn()} collapsible collapseStorageKey={storageKey} projectId="project-a" />,
    );

    expect(screen.getByRole("button", { name: /^Workflow$/i })).toBeDefined();
    expect(screen.queryByRole("combobox")).toBeNull();

    rerender(<WorkflowSelector value={null} onChange={vi.fn()} collapsible collapseStorageKey={storageKey} projectId="project-b" />);

    expect(screen.getByRole("combobox", { name: /Workflow/i })).toBeDefined();
  });

  it("keeps the select disabled while loading and when disabled is passed", async () => {
    fetchWorkflowsMock.mockReturnValue(new Promise(() => undefined));
    const { rerender } = render(
      <WorkflowSelector value={null} onChange={vi.fn()} collapsible collapseStorageKey={storageKey} />,
    );

    expect(screen.getByRole("combobox", { name: /Workflow/i })).toBeDisabled();

    fetchWorkflowsMock.mockResolvedValue([]);
    rerender(<WorkflowSelector value={null} onChange={vi.fn()} collapsible collapseStorageKey={storageKey} disabled />);

    await waitFor(() => expect(screen.getByRole("combobox", { name: /Workflow/i })).toBeDisabled());
  });

  it("renders the None option when the workflow list is empty", async () => {
    fetchWorkflowsMock.mockResolvedValue([]);

    render(<WorkflowSelector value={null} onChange={vi.fn()} collapsible collapseStorageKey={storageKey} />);

    await waitFor(() => expect(screen.getByRole("option", { name: "None" })).toBeDefined());
    expect(screen.queryByRole("option", { name: "Workflow A" })).toBeNull();
  });
});

describe("WorkflowSelector switch-with-active-session confirm (U9)", () => {
  it("shows the abort-warning confirm and applies the switch when confirmed", async () => {
    mockConfirm.mockResolvedValue(true);
    const onChange = vi.fn().mockResolvedValue(undefined);
    render(<WorkflowSelector value="wf-a" onChange={onChange} hasActiveSession />);
    await waitFor(() => expect(screen.getByRole("combobox")).toBeDefined());
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "wf-b" } });
    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("wf-b"));
  });

  it("does NOT apply the switch when the confirm is cancelled", async () => {
    mockConfirm.mockResolvedValue(false);
    const onChange = vi.fn().mockResolvedValue(undefined);
    render(<WorkflowSelector value="wf-a" onChange={onChange} hasActiveSession />);
    await waitFor(() => expect(screen.getByRole("combobox")).toBeDefined());
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "wf-b" } });
    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("skips the confirm when the task has no active session", async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    render(<WorkflowSelector value="wf-a" onChange={onChange} />);
    await waitFor(() => expect(screen.getByRole("combobox")).toBeDefined());
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "wf-b" } });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("wf-b"));
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it("appends the current workflow when it is hidden from the filtered list", async () => {
    render(<WorkflowSelector value="builtin:hidden" onChange={vi.fn()} />);

    await waitFor(() => expect(fetchWorkflowMock).toHaveBeenCalledWith("builtin:hidden", undefined));
    expect(screen.getByRole("option", { name: "Hidden built-in" })).toBeDefined();
  });
});
