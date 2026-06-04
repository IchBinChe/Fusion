import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TaskFieldsSection } from "../TaskFieldsSection";
import type { WorkflowFieldDefinition, CustomFieldRejection } from "../../api";

const enumField: WorkflowFieldDefinition = {
  id: "severity",
  name: "Severity",
  type: "enum",
  options: [
    { value: "low", label: "Low", color: "#22c55e" },
    { value: "high", label: "High", color: "#ef4444" },
  ],
  render: { placement: "detail", widget: "select" },
};

describe("TaskFieldsSection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders nothing when there are no fields and no orphaned values (today's UI)", () => {
    const { container } = render(
      <TaskFieldsSection fieldDefs={[]} customFields={{}} onSave={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when only card-placed fields exist (those go on the card)", () => {
    const { container } = render(
      <TaskFieldsSection
        fieldDefs={[{ id: "x", name: "X", type: "string", render: { placement: "card" } }]}
        customFields={{}}
        onSave={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("enum select renders options and edits via onSave", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<TaskFieldsSection fieldDefs={[enumField]} customFields={{ severity: "low" }} onSave={onSave} />);
    const select = screen.getByLabelText("Severity") as HTMLSelectElement;
    expect(select.value).toBe("low");
    fireEvent.change(select, { target: { value: "high" } });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ severity: "high" }));
  });

  it("enum radio widget commits the chosen option", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const field: WorkflowFieldDefinition = { ...enumField, render: { placement: "detail", widget: "radio" } };
    render(<TaskFieldsSection fieldDefs={[field]} customFields={{}} onSave={onSave} />);
    fireEvent.click(screen.getByLabelText("High"));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ severity: "high" }));
  });

  it("enum chips widget toggles selection and applies option color", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const field: WorkflowFieldDefinition = { ...enumField, render: { placement: "detail", widget: "chips" } };
    render(<TaskFieldsSection fieldDefs={[field]} customFields={{ severity: "high" }} onSave={onSave} />);
    const highChip = screen.getByRole("button", { name: "High" });
    // Enum color applied to the active chip.
    expect(highChip.getAttribute("style")).toContain("rgb(239, 68, 68)");
    // Clicking the active chip clears it (commits null).
    fireEvent.click(highChip);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ severity: null }));
  });

  it("multi-enum chips add/remove members", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const field: WorkflowFieldDefinition = {
      id: "tags",
      name: "Tags",
      type: "multi-enum",
      options: [
        { value: "a", label: "Alpha" },
        { value: "b", label: "Beta" },
      ],
      render: { placement: "detail" },
    };
    render(<TaskFieldsSection fieldDefs={[field]} customFields={{ tags: ["a"] }} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Beta" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ tags: ["a", "b"] }));
  });

  it("boolean toggle commits true/false", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const field: WorkflowFieldDefinition = { id: "done", name: "Done", type: "boolean", render: { placement: "detail" } };
    render(<TaskFieldsSection fieldDefs={[field]} customFields={{ done: false }} onSave={onSave} />);
    fireEvent.click(screen.getByLabelText("Done"));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ done: true }));
  });

  it("string input commits on blur", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const field: WorkflowFieldDefinition = { id: "owner", name: "Owner", type: "string", render: { placement: "detail" } };
    render(<TaskFieldsSection fieldDefs={[field]} customFields={{}} onSave={onSave} />);
    const input = screen.getByLabelText("Owner") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "alice" } });
    fireEvent.blur(input);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ owner: "alice" }));
  });

  it("text widget renders a textarea and commits on blur", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const field: WorkflowFieldDefinition = { id: "notes", name: "Notes", type: "text", render: { placement: "detail" } };
    render(<TaskFieldsSection fieldDefs={[field]} customFields={{}} onSave={onSave} />);
    const ta = screen.getByLabelText("Notes") as HTMLTextAreaElement;
    expect(ta.tagName).toBe("TEXTAREA");
    fireEvent.change(ta, { target: { value: "hi" } });
    fireEvent.blur(ta);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ notes: "hi" }));
  });

  it("number input commits a numeric value", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const field: WorkflowFieldDefinition = { id: "count", name: "Count", type: "number", render: { placement: "detail" } };
    render(<TaskFieldsSection fieldDefs={[field]} customFields={{}} onSave={onSave} />);
    const input = screen.getByLabelText("Count") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "42" } });
    fireEvent.blur(input);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ count: 42 }));
  });

  it("url and date inputs render with the correct input type", () => {
    const fields: WorkflowFieldDefinition[] = [
      { id: "link", name: "Link", type: "url", render: { placement: "detail" } },
      { id: "due", name: "Due", type: "date", render: { placement: "detail" } },
    ];
    render(<TaskFieldsSection fieldDefs={fields} customFields={{ due: "2026-06-04T00:00:00.000Z" }} onSave={vi.fn()} />);
    expect((screen.getByLabelText("Link") as HTMLInputElement).type).toBe("url");
    const due = screen.getByLabelText("Due") as HTMLInputElement;
    expect(due.type).toBe("date");
    expect(due.value).toBe("2026-06-04");
  });

  it("surfaces the typed rejection inline beneath the offending field", () => {
    const error: CustomFieldRejection = { code: "enum-violation", fieldId: "severity", detail: "value not allowed" };
    render(<TaskFieldsSection fieldDefs={[enumField]} customFields={{}} onSave={vi.fn()} error={error} />);
    expect(screen.getByTestId("task-field-error-severity").textContent).toBe("value not allowed");
    expect(screen.getByTestId("task-field-row-severity").className).toContain("has-error");
  });

  it("groups detail-section fields under a collapsible disclosure", () => {
    const fields: WorkflowFieldDefinition[] = [
      { id: "a", name: "Inline", type: "string", render: { placement: "detail" } },
      { id: "b", name: "Sectioned", type: "string", render: { placement: "detail-section" } },
    ];
    render(<TaskFieldsSection fieldDefs={fields} customFields={{}} onSave={vi.fn()} />);
    // Both visible while the section is open by default.
    expect(screen.getByLabelText("Inline")).toBeTruthy();
    expect(screen.getByLabelText("Sectioned")).toBeTruthy();
    // Collapsing hides the sectioned field but keeps the inline one.
    fireEvent.click(screen.getByTestId("task-fields-group-toggle"));
    expect(screen.queryByLabelText("Sectioned")).toBeNull();
    expect(screen.getByLabelText("Inline")).toBeTruthy();
  });

  it("renders orphaned values read-only under a collapsed disclosure", () => {
    render(
      <TaskFieldsSection
        fieldDefs={[enumField]}
        customFields={{ severity: "low", legacyField: "stale" }}
        onSave={vi.fn()}
      />,
    );
    // Disclosure present but collapsed by default → body hidden.
    expect(screen.getByTestId("task-fields-orphaned-toggle")).toBeTruthy();
    expect(screen.queryByTestId("task-fields-orphaned-body")).toBeNull();
    fireEvent.click(screen.getByTestId("task-fields-orphaned-toggle"));
    const body = screen.getByTestId("task-fields-orphaned-body");
    expect(body.textContent).toContain("legacyField");
    expect(body.textContent).toContain("stale");
  });

  it("does not call onSave when readOnly", () => {
    const onSave = vi.fn();
    render(<TaskFieldsSection fieldDefs={[enumField]} customFields={{ severity: "low" }} onSave={onSave} readOnly />);
    const select = screen.getByLabelText("Severity") as HTMLSelectElement;
    expect(select.disabled).toBe(true);
  });
});
