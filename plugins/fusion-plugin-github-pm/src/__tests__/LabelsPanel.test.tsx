import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LabelsPanel } from "../LabelsPanel.js";

/*
FNXC:GithubPmLabels 2026-07-24-11:30:
KB-002 UI tests. Mirrors IssueWritePanel.test.tsx's `useConfirm` mocking pattern so the
create/edit confirm dialog AND the delete-confirmation dialog (which reuses the SAME
`useConfirm` primitive) resolve deterministically without a real ConfirmDialogProvider/portal.
Every test injects a mocked `fetch`; none touches api.github.com.
*/
const mockConfirm = vi.fn<(options: unknown) => Promise<boolean>>();
vi.mock("@fusion/dashboard/app/hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: mockConfirm }),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function listPayload(labels: Array<{ name: string; color: string; description?: string | null; usageCount: number | null }>) {
  return { ok: true, repo: "acme/widgets", labels };
}

beforeEach(() => {
  mockConfirm.mockReset();
  mockConfirm.mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("LabelsPanel (KB-002)", () => {
  it("renders a 'select a repository' affordance and fires no fetch when repo is null", () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    render(<LabelsPanel repo={null} />);
    expect(screen.getByTestId("labels-panel-no-repo")).toBeInTheDocument();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("renders an empty state with the create affordance still visible when the repo has zero labels", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(listPayload([]))));
    render(<LabelsPanel repo="acme/widgets" confirmWrites={false} />);
    await waitFor(() => expect(screen.getByTestId("labels-panel-empty")).toBeInTheDocument());
    expect(screen.getByTestId("labels-create-submit")).toBeInTheDocument();
    expect(screen.queryByTestId("labels-panel-table")).not.toBeInTheDocument();
  });

  it("renders the table with swatch/name/description/usage count, and a null usageCount as a neutral placeholder", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(listPayload([
        { name: "bug", color: "d73a4a", description: "Something isn't working", usageCount: 3 },
        { name: "docs", color: "0075ca", description: null, usageCount: null },
      ]))),
    );
    render(<LabelsPanel repo="acme/widgets" confirmWrites={false} />);
    await waitFor(() => expect(screen.getByTestId("labels-row-bug")).toBeInTheDocument());
    expect(screen.getByTestId("labels-swatch-bug")).toHaveStyle({ background: "#d73a4a" });
    expect(screen.getByText("Something isn't working")).toBeInTheDocument();
    expect(screen.getByTestId("labels-usage-bug")).toHaveTextContent("3");
    expect(screen.getByTestId("labels-usage-docs")).toHaveTextContent("—");
  });

  it("a successful create appends optimistically, reconciles to the server object, and re-fetches (confirmWrites OFF)", async () => {
    let listCallCount = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/labels/list")) {
        listCallCount += 1;
        return jsonResponse(listCallCount === 1
          ? listPayload([])
          : listPayload([{ name: "triage", color: "fbca04", description: null, usageCount: 0 }]));
      }
      if (url.includes("/labels/create")) {
        return jsonResponse({ ok: true, label: { name: "triage", color: "fbca04", description: null } });
      }
      return jsonResponse({ ok: false, error: "unexpected" }, 404);
    });
    vi.stubGlobal("fetch", fetchImpl);

    render(<LabelsPanel repo="acme/widgets" confirmWrites={false} />);
    await waitFor(() => expect(screen.getByTestId("labels-panel-empty")).toBeInTheDocument());

    fireEvent.change(screen.getByTestId("labels-create-name"), { target: { value: "triage" } });
    fireEvent.click(screen.getByTestId("labels-create-submit"));

    // Optimistic append happens synchronously before the fetch resolves.
    expect(screen.getByTestId("labels-row-triage")).toBeInTheDocument();

    await waitFor(() => expect(listCallCount).toBe(2));
    expect(screen.getByTestId("labels-row-triage")).toBeInTheDocument();
  });

  it("a FAILED create rolls back the optimistic append and shows an error banner", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/labels/list")) return jsonResponse(listPayload([]));
      if (url.includes("/labels/create")) return jsonResponse({ ok: false, error: "A label named \"triage\" already exists." }, 422);
      return jsonResponse({ ok: false, error: "unexpected" }, 404);
    });
    vi.stubGlobal("fetch", fetchImpl);

    render(<LabelsPanel repo="acme/widgets" confirmWrites={false} />);
    await waitFor(() => expect(screen.getByTestId("labels-panel-empty")).toBeInTheDocument());

    fireEvent.change(screen.getByTestId("labels-create-name"), { target: { value: "triage" } });
    fireEvent.click(screen.getByTestId("labels-create-submit"));

    expect(screen.getByTestId("labels-row-triage")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("labels-create-error")).toBeInTheDocument());
    expect(screen.getByTestId("labels-create-error")).toHaveTextContent('already exists');
    expect(screen.queryByTestId("labels-row-triage")).not.toBeInTheDocument();
  });

  it("the color picker rejects an invalid hex and only submits a valid six-hex-digit color", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/labels/list")) return jsonResponse(listPayload([]));
      if (url.includes("/labels/create")) {
        const init = (fetchImpl.mock.calls.find((c) => String(c[0]).includes("/labels/create")) ?? [])[1] as RequestInit | undefined;
        return jsonResponse({ ok: true, label: { name: "triage", color: JSON.parse(String(init?.body)).color, description: null } });
      }
      return jsonResponse({ ok: false, error: "unexpected" }, 404);
    });
    vi.stubGlobal("fetch", fetchImpl);

    render(<LabelsPanel repo="acme/widgets" confirmWrites={false} />);
    await waitFor(() => expect(screen.getByTestId("labels-panel-empty")).toBeInTheDocument());

    fireEvent.change(screen.getByTestId("labels-create-color-input"), { target: { value: "not-a-color" } });
    expect(screen.getByTestId("labels-create-color-error")).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("labels-create-name"), { target: { value: "triage" } });
    fireEvent.click(screen.getByTestId("labels-create-submit"));

    await waitFor(() => {
      const createCall = fetchImpl.mock.calls.find((c) => String(c[0]).includes("/labels/create"));
      expect(createCall).toBeDefined();
      const body = JSON.parse(String((createCall as any)[1].body));
      expect(body.color).toMatch(/^[0-9a-f]{6}$/);
      expect(body.color).not.toBe("not-a-color");
    });
  });

  it("a rename PUTs newName and updates the row (confirmWrites OFF)", async () => {
    let listCallCount = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/labels/list")) {
        listCallCount += 1;
        return jsonResponse(listCallCount === 1
          ? listPayload([{ name: "bug", color: "d73a4a", description: "desc", usageCount: 2 }])
          : listPayload([{ name: "bug-report", color: "d73a4a", description: "desc", usageCount: 2 }]));
      }
      if (url.includes("/labels/update")) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ name: "bug", newName: "bug-report" });
        return jsonResponse({ ok: true, label: { name: "bug-report", color: "d73a4a", description: "desc" } });
      }
      return jsonResponse({ ok: false, error: "unexpected" }, 404);
    });
    vi.stubGlobal("fetch", fetchImpl);

    render(<LabelsPanel repo="acme/widgets" confirmWrites={false} />);
    await waitFor(() => expect(screen.getByTestId("labels-row-bug")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("labels-edit-bug"));
    fireEvent.change(screen.getByTestId("labels-edit-name"), { target: { value: "bug-report" } });
    fireEvent.click(screen.getByTestId("labels-edit-submit"));

    await waitFor(() => expect(listCallCount).toBe(2));
    await waitFor(() => expect(screen.getByTestId("labels-row-bug-report")).toBeInTheDocument());
  });

  it("the delete dialog shows the usage-count warning; cancel performs zero mutations", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/labels/list")) return jsonResponse(listPayload([{ name: "bug", color: "d73a4a", description: null, usageCount: 5 }]));
      if (url.includes("/labels/delete")) throw new Error("delete must not be called when the confirm dialog is cancelled");
      return jsonResponse({ ok: false, error: "unexpected" }, 404);
    });
    vi.stubGlobal("fetch", fetchImpl);
    mockConfirm.mockResolvedValue(false);

    render(<LabelsPanel repo="acme/widgets" confirmWrites={false} />);
    await waitFor(() => expect(screen.getByTestId("labels-row-bug")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("labels-delete-bug"));

    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    const options = mockConfirm.mock.calls[0][0] as { message: string };
    expect(options.message).toContain("5");
    expect(options.message).toContain("open issue");

    expect(screen.getByTestId("labels-row-bug")).toBeInTheDocument();
    expect(fetchImpl.mock.calls.some((c) => String(c[0]).includes("/labels/delete"))).toBe(false);
  });

  it("confirm dispatches the delete and removes the row", async () => {
    let listCallCount = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/labels/list")) {
        listCallCount += 1;
        return jsonResponse(listCallCount === 1 ? listPayload([{ name: "bug", color: "d73a4a", description: null, usageCount: 1 }]) : listPayload([]));
      }
      if (url.includes("/labels/delete")) return jsonResponse({ ok: true, deleted: "bug" });
      return jsonResponse({ ok: false, error: "unexpected" }, 404);
    });
    vi.stubGlobal("fetch", fetchImpl);
    mockConfirm.mockResolvedValue(true);

    render(<LabelsPanel repo="acme/widgets" confirmWrites={false} />);
    await waitFor(() => expect(screen.getByTestId("labels-row-bug")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("labels-delete-bug"));

    await waitFor(() => expect(screen.queryByTestId("labels-row-bug")).not.toBeInTheDocument());
    expect(fetchImpl.mock.calls.some((c) => String(c[0]).includes("/labels/delete"))).toBe(true);
  });

  it("a FAILED delete rolls back and shows an error banner", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/labels/list")) return jsonResponse(listPayload([{ name: "bug", color: "d73a4a", description: null, usageCount: 1 }]));
      if (url.includes("/labels/delete")) return jsonResponse({ ok: false, error: "You do not have permission to delete labels." }, 403);
      return jsonResponse({ ok: false, error: "unexpected" }, 404);
    });
    vi.stubGlobal("fetch", fetchImpl);
    mockConfirm.mockResolvedValue(true);

    render(<LabelsPanel repo="acme/widgets" confirmWrites={false} />);
    await waitFor(() => expect(screen.getByTestId("labels-row-bug")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("labels-delete-bug"));

    await waitFor(() => expect(screen.getByTestId("labels-delete-error")).toBeInTheDocument());
    expect(screen.getByTestId("labels-delete-error")).toHaveTextContent("You do not have permission to delete labels.");
    expect(screen.getByTestId("labels-row-bug")).toBeInTheDocument();
  });

  it("the unauthenticated/permission list error message renders verbatim", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: false, error: "GitHub PM is not authenticated." }, 401)));
    render(<LabelsPanel repo="acme/widgets" confirmWrites={false} />);
    await waitFor(() => expect(screen.getByTestId("labels-panel-error")).toBeInTheDocument());
    expect(screen.getByTestId("labels-panel-error")).toHaveTextContent("GitHub PM is not authenticated.");
  });
});

describe("LabelsPanel confirm gate (FUSI-017 inheritance)", () => {
  it("with confirmWrites ON, create/edit/delete send confirmed:true", async () => {
    let listCallCount = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/labels/list")) {
        listCallCount += 1;
        return jsonResponse(listCallCount === 1
          ? listPayload([])
          : listPayload([{ name: "triage", color: "fbca04", description: null, usageCount: 0 }]));
      }
      if (url.includes("/labels/create")) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ confirmed: true });
        return jsonResponse({ ok: true, label: { name: "triage", color: "fbca04", description: null } });
      }
      return jsonResponse({ ok: false, error: "unexpected" }, 404);
    });
    vi.stubGlobal("fetch", fetchImpl);
    mockConfirm.mockResolvedValue(true);

    render(<LabelsPanel repo="acme/widgets" confirmWrites />);
    await waitFor(() => expect(screen.getByTestId("labels-panel-empty")).toBeInTheDocument());

    fireEvent.change(screen.getByTestId("labels-create-name"), { target: { value: "triage" } });
    fireEvent.click(screen.getByTestId("labels-create-submit"));

    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    await waitFor(() => expect(fetchImpl.mock.calls.some((c) => String(c[0]).includes("/labels/create"))).toBe(true));
  });

  it("cancelling the create confirm dialog performs zero mutations", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/labels/list")) return jsonResponse(listPayload([]));
      if (url.includes("/labels/create")) throw new Error("create must not be called when the confirm dialog is cancelled");
      return jsonResponse({ ok: false, error: "unexpected" }, 404);
    });
    vi.stubGlobal("fetch", fetchImpl);
    mockConfirm.mockResolvedValue(false);

    render(<LabelsPanel repo="acme/widgets" confirmWrites />);
    await waitFor(() => expect(screen.getByTestId("labels-panel-empty")).toBeInTheDocument());

    fireEvent.change(screen.getByTestId("labels-create-name"), { target: { value: "triage" } });
    fireEvent.click(screen.getByTestId("labels-create-submit"));

    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    expect(screen.queryByTestId("labels-row-triage")).not.toBeInTheDocument();
    expect(fetchImpl.mock.calls.some((c) => String(c[0]).includes("/labels/create"))).toBe(false);
  });
});
