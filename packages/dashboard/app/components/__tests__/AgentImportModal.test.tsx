import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentImportModal } from "../AgentImportModal";

interface MockResponse {
  ok: boolean;
  status?: number;
  body: unknown;
}

function mockResponse({ ok, status = ok ? 200 : 400, body }: MockResponse): Promise<Response> {
  return Promise.resolve({
    ok,
    status,
    json: async () => body,
  } as Response);
}

describe("AgentImportModal", () => {
  const onClose = vi.fn();
  const onImported = vi.fn();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  function renderModal(isOpen = true) {
    return render(
      <AgentImportModal
        isOpen={isOpen}
        onClose={onClose}
        onImported={onImported}
      />,
    );
  }

  async function goToPreview(manifest = "---\nname: Reviewer\nrole: reviewer\n---") {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      await mockResponse({
        ok: true,
        body: {
          companyName: "Acme AI",
          agents: [
            { name: "Reviewer", role: "reviewer", title: "Code Reviewer", skills: ["review"] },
            { name: "Planner", role: "triage", title: "Planner" },
          ],
          created: ["Reviewer", "Planner"],
          skipped: [],
          errors: [],
          dryRun: true,
        },
      }),
    );

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Manifest content"), manifest);
    await user.click(screen.getByRole("button", { name: "Preview" }));

    await waitFor(() => {
      expect(screen.getByText("Acme AI")).toBeInTheDocument();
      expect(screen.getByText("2 agents found")).toBeInTheDocument();
    });
  }

  it("returns null when isOpen=false", () => {
    renderModal(false);
    expect(screen.queryByText("Import Agents")).not.toBeInTheDocument();
  });

  it("renders title when open", () => {
    renderModal(true);
    expect(screen.getByText("Import Agents")).toBeInTheDocument();
  });

  it("shows file upload area and textarea in input step", () => {
    renderModal(true);

    expect(screen.getByRole("button", { name: "Choose File" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Select Directory" })).toBeInTheDocument();
    expect(screen.getByLabelText("Manifest content")).toBeInTheDocument();
  });

  it("disables Preview when manifest is empty and enables after typing", async () => {
    renderModal(true);

    const user = userEvent.setup();
    const preview = screen.getByRole("button", { name: "Preview" });
    expect(preview).toBeDisabled();

    await user.type(screen.getByLabelText("Manifest content"), "name: test-agent");
    expect(preview).toBeEnabled();
  });

  it("handleParse posts dryRun import request and moves to preview step", async () => {
    renderModal(true);

    await goToPreview();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/agents/import",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );

    const body = JSON.parse(vi.mocked(globalThis.fetch).mock.calls[0][1]!.body as string);
    expect(body).toMatchObject({
      dryRun: true,
      manifest: expect.stringContaining("name: Reviewer"),
    });
  });

  it("preview shows company name, count, and agent list", async () => {
    renderModal(true);

    await goToPreview();

    expect(screen.getByText("Acme AI")).toBeInTheDocument();
    expect(screen.getByText("2 agents found")).toBeInTheDocument();
    expect(screen.getByText("Reviewer")).toBeInTheDocument();
    expect(screen.getByText("Planner")).toBeInTheDocument();
    expect(screen.getByText(/reviewer/)).toBeInTheDocument();
    expect(screen.getByText(/triage/)).toBeInTheDocument();
  });

  it("Back button returns to input step", async () => {
    renderModal(true);
    await goToPreview();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Back" }));

    expect(screen.getByLabelText("Manifest content")).toBeInTheDocument();
    expect(screen.queryByText("2 agents found")).not.toBeInTheDocument();
  });

  it("handleImport posts live import request and transitions to result step", async () => {
    renderModal(true);

    await goToPreview();

    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      await mockResponse({
        ok: true,
        body: {
          companyName: "Acme AI",
          created: [{ id: "agent-1", name: "Reviewer" }],
          skipped: ["Planner"],
          errors: [{ name: "Writer", error: "Invalid role" }],
        },
      }),
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Import 2 Agents/i }));

    await waitFor(() => {
      expect(screen.getByText("Import Complete")).toBeInTheDocument();
    });

    const body = JSON.parse(vi.mocked(globalThis.fetch).mock.calls[1][1]!.body as string);
    expect(body).toMatchObject({
      manifest: expect.stringContaining("name: Reviewer"),
      skipExisting: true,
    });
    expect(body).not.toHaveProperty("dryRun");
  });

  it("result step shows created/skipped/error counts and created names", async () => {
    renderModal(true);
    await goToPreview();

    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      await mockResponse({
        ok: true,
        body: {
          companyName: "Acme AI",
          created: [{ id: "agent-1", name: "Reviewer" }, { id: "agent-2", name: "Planner" }],
          skipped: ["Writer"],
          errors: [{ name: "Ops", error: "Bad schema" }],
        },
      }),
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Import 2 Agents/i }));

    await waitFor(() => {
      expect(screen.getByText(/2 created/)).toBeInTheDocument();
      expect(screen.getByText(/1 skipped/)).toBeInTheDocument();
      expect(screen.getByText(/1 error/)).toBeInTheDocument();
    });

    expect(screen.getByText("Reviewer")).toBeInTheDocument();
    expect(screen.getByText("Planner")).toBeInTheDocument();
  });

  it("calls onImported after successful import", async () => {
    renderModal(true);
    await goToPreview();

    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      await mockResponse({
        ok: true,
        body: {
          companyName: "Acme AI",
          created: [{ id: "agent-1", name: "Reviewer" }],
          skipped: [],
          errors: [],
        },
      }),
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Import 2 Agents/i }));

    await waitFor(() => {
      expect(onImported).toHaveBeenCalledTimes(1);
    });
  });

  it("shows parse API errors", async () => {
    renderModal(true);

    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      await mockResponse({ ok: false, body: { error: "No agents found" } }),
    );

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Manifest content"), "invalid manifest");
    await user.click(screen.getByRole("button", { name: "Preview" }));

    await waitFor(() => {
      expect(screen.getByText("No agents found")).toBeInTheDocument();
    });
  });

  it("shows import API errors", async () => {
    renderModal(true);
    await goToPreview();

    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      await mockResponse({ ok: false, body: { error: "Import failed" } }),
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Import 2 Agents/i }));

    await waitFor(() => {
      expect(screen.getByText("Import failed")).toBeInTheDocument();
    });
  });

  it("Cancel/Close calls onClose and resets state", async () => {
    const { rerender } = renderModal(true);

    await goToPreview();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(<AgentImportModal isOpen={true} onClose={onClose} onImported={onImported} />);

    expect(screen.getByLabelText("Manifest content")).toHaveValue("");
    expect(screen.queryByText("2 agents found")).not.toBeInTheDocument();
  });

  it("clicking overlay triggers handleClose", () => {
    const { container } = renderModal(true);

    const overlay = container.querySelector(".agent-dialog-overlay");
    expect(overlay).toBeTruthy();

    fireEvent.click(overlay!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
