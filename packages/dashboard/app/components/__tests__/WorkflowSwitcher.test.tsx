import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BoardWorkflowDefinition } from "../../api";
import { loadAllAppCssBaseOnly } from "../../test/cssFixture";
import { WorkflowSwitcher } from "../WorkflowSwitcher";
import type { WorkflowStatusCounts } from "../workflowStatusCounts";

const workflows: BoardWorkflowDefinition[] = [
  {
    id: "coding",
    name: "Coding",
    columns: [],
  },
  {
    id: "design",
    name: "Design",
    columns: [],
  },
];

function countMap(entries: Array<[string, WorkflowStatusCounts]> = []) {
  return new Map<string, WorkflowStatusCounts>(entries);
}

function cssRuleFor(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

describe("WorkflowSwitcher", () => {
  it("renders the active workflow without compact counts while collapsed", () => {
    render(
      <WorkflowSwitcher
        workflows={workflows}
        value="coding"
        onChange={vi.fn()}
        counts={countMap([["coding", { todo: 3, inProgress: 1, done: 5 }]])}
      />,
    );

    const trigger = screen.getByTestId("workflow-switcher");
    expect(trigger).toHaveTextContent("Coding");
    expect(within(trigger).queryByText("3", { selector: ".workflow-switcher-count--todo" })).not.toBeInTheDocument();
    expect(within(trigger).queryByText("1", { selector: ".workflow-switcher-count--in-progress" })).not.toBeInTheDocument();
    expect(within(trigger).queryByText("5", { selector: ".workflow-switcher-count--done" })).not.toBeInTheDocument();
    expect(trigger.querySelector(".workflow-switcher-counts--trigger")).toBeNull();
    expect(trigger).toHaveAccessibleName("Select workflow. Current workflow: Coding");
  });

  it("opens and closes the portaled listbox", () => {
    render(<WorkflowSwitcher workflows={workflows} value="coding" onChange={vi.fn()} counts={countMap()} />);

    fireEvent.click(screen.getByTestId("workflow-switcher"));
    expect(screen.getByRole("listbox", { name: "Workflow" })).toBeInTheDocument();
    expect(screen.getByTestId("workflow-switcher-option-coding")).toHaveAttribute("aria-selected", "true");

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox", { name: "Workflow" })).not.toBeInTheDocument();
  });

  it("fires onOpen only on click-driven closed-to-open transitions", () => {
    const onOpen = vi.fn();
    render(<WorkflowSwitcher workflows={workflows} value="coding" onChange={vi.fn()} counts={countMap()} onOpen={onOpen} />);

    const trigger = screen.getByTestId("workflow-switcher");
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("listbox", { name: "Workflow" })).toBeInTheDocument();

    fireEvent.click(trigger);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("listbox", { name: "Workflow" })).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it.each(["ArrowDown", "ArrowUp", "Enter", " "])("fires onOpen when %s opens the dropdown from the keyboard", (key) => {
    const onOpen = vi.fn();
    render(<WorkflowSwitcher workflows={workflows} value="coding" onChange={vi.fn()} counts={countMap()} onOpen={onOpen} />);

    const trigger = screen.getByTestId("workflow-switcher");
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.keyDown(trigger, { key });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("listbox", { name: "Workflow" })).toBeInTheDocument();
  });

  it("does not fire onOpen when Escape or outside mousedown closes and fires again after reopening", () => {
    const onOpen = vi.fn();
    render(<WorkflowSwitcher workflows={workflows} value="coding" onChange={vi.fn()} counts={countMap()} onOpen={onOpen} />);

    const trigger = screen.getByTestId("workflow-switcher");
    fireEvent.click(trigger);
    expect(onOpen).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("listbox", { name: "Workflow" })).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(onOpen).toHaveBeenCalledTimes(2);
    fireEvent.mouseDown(document.body);
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("listbox", { name: "Workflow" })).not.toBeInTheDocument();

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(onOpen).toHaveBeenCalledTimes(3);
  });

  it("calls onChange when an option is selected", () => {
    const onChange = vi.fn();
    render(<WorkflowSwitcher workflows={workflows} value="coding" onChange={onChange} counts={countMap()} />);

    fireEvent.click(screen.getByTestId("workflow-switcher"));
    fireEvent.click(screen.getByTestId("workflow-switcher-option-design"));

    expect(onChange).toHaveBeenCalledWith("design");
    expect(screen.queryByRole("listbox", { name: "Workflow" })).not.toBeInTheDocument();
  });

  it("supports keyboard navigation and escape dismissal", () => {
    const onChange = vi.fn();
    render(<WorkflowSwitcher workflows={workflows} value="coding" onChange={onChange} counts={countMap()} />);

    const trigger = screen.getByTestId("workflow-switcher");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith("design");

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.getByRole("listbox", { name: "Workflow" })).toBeInTheDocument();
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Workflow" })).not.toBeInTheDocument();
  });

  it("renders per-row edit buttons that close without selecting workflows", () => {
    const onChange = vi.fn();
    const onEditWorkflow = vi.fn();
    render(
      <WorkflowSwitcher
        workflows={workflows}
        value="coding"
        onChange={onChange}
        counts={countMap()}
        onEditWorkflow={onEditWorkflow}
      />,
    );

    fireEvent.click(screen.getByTestId("workflow-switcher"));
    fireEvent.click(screen.getByTestId("workflow-switcher-edit-design"));

    expect(onEditWorkflow).toHaveBeenCalledWith("design");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox", { name: "Workflow" })).not.toBeInTheDocument();
  });

  it("renders a persistent New workflow footer for single and many workflow lists", () => {
    const onCreateWorkflow = vi.fn();
    const { rerender } = render(
      <WorkflowSwitcher
        workflows={[workflows[0]]}
        value="coding"
        onChange={vi.fn()}
        counts={countMap()}
        onCreateWorkflow={onCreateWorkflow}
      />,
    );

    fireEvent.click(screen.getByTestId("workflow-switcher"));
    expect(screen.getByTestId("workflow-switcher-create")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("workflow-switcher-create"));
    expect(onCreateWorkflow).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("listbox", { name: "Workflow" })).not.toBeInTheDocument();

    const manyWorkflows = Array.from({ length: 8 }, (_, index) => ({
      id: `workflow-${index}`,
      name: `Workflow ${index}`,
      columns: [],
    }));
    rerender(
      <WorkflowSwitcher
        workflows={manyWorkflows}
        value="workflow-0"
        onChange={vi.fn()}
        counts={countMap()}
        onCreateWorkflow={onCreateWorkflow}
      />,
    );

    fireEvent.click(screen.getByTestId("workflow-switcher"));
    expect(screen.getByTestId("workflow-switcher-create")).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(manyWorkflows.length);
  });

  it("keeps Enter selection scoped to highlighted workflow options when actions exist", () => {
    const onChange = vi.fn();
    const onEditWorkflow = vi.fn();
    const onCreateWorkflow = vi.fn();
    render(
      <WorkflowSwitcher
        workflows={workflows}
        value="coding"
        onChange={onChange}
        counts={countMap()}
        onEditWorkflow={onEditWorkflow}
        onCreateWorkflow={onCreateWorkflow}
      />,
    );

    const trigger = screen.getByTestId("workflow-switcher");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith("design");
    expect(onEditWorkflow).not.toHaveBeenCalled();
    expect(onCreateWorkflow).not.toHaveBeenCalled();
  });

  it("renders populated and zero counts only after the dropdown expands", () => {
    render(
      <WorkflowSwitcher
        workflows={workflows}
        value="coding"
        onChange={vi.fn()}
        counts={countMap([["coding", { todo: 3, inProgress: 1, done: 5 }]])}
      />,
    );

    const trigger = screen.getByTestId("workflow-switcher");
    expect(trigger.querySelector(".workflow-switcher-counts")).not.toBeInTheDocument();

    fireEvent.click(trigger);

    expect(within(trigger).getByText("3", { selector: ".workflow-switcher-count--todo" })).toBeInTheDocument();
    expect(within(trigger).getByText("1", { selector: ".workflow-switcher-count--in-progress" })).toBeInTheDocument();
    expect(within(trigger).getByText("5", { selector: ".workflow-switcher-count--done" })).toBeInTheDocument();

    const codingOption = screen.getByTestId("workflow-switcher-option-coding");
    expect(within(codingOption).getByText("3", { selector: ".workflow-switcher-count--todo" })).toBeInTheDocument();
    expect(within(codingOption).getByText("1", { selector: ".workflow-switcher-count--in-progress" })).toBeInTheDocument();
    expect(within(codingOption).getByText("5", { selector: ".workflow-switcher-count--done" })).toBeInTheDocument();

    const designOption = screen.getByTestId("workflow-switcher-option-design");
    expect(within(designOption).getByText("0", { selector: ".workflow-switcher-count--todo" })).toBeInTheDocument();
    expect(within(designOption).getByText("0", { selector: ".workflow-switcher-count--in-progress" })).toBeInTheDocument();
    expect(within(designOption).getByText("0", { selector: ".workflow-switcher-count--done" })).toBeInTheDocument();
  });

  it("colors status counts with board column color tokens", () => {
    const css = loadAllAppCssBaseOnly();
    const badgeRules = [
      [".workflow-switcher-count--todo", "--todo"],
      [".workflow-switcher-count--in-progress", "--in-progress"],
      [".workflow-switcher-count--done", "--done"],
    ] as const;

    for (const [selector, token] of badgeRules) {
      const rule = cssRuleFor(css, selector);
      expect(rule).toMatch(new RegExp(`color:\\s*var\\(${token}\\)`));
      expect(rule).not.toMatch(/var\(--(?:text-muted|color-warning|color-success)\)/);
      expect(rule).not.toMatch(/#[0-9a-fA-F]{3,8}|rgba?\(/);
    }
  });
});
