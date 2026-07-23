import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MilestonesPanel } from "../MilestonesPanel.js";

/*
FNXC:GithubPmMilestones 2026-07-25-01:50:
KB-003 component tests, mirroring IssueWritePanel.test.tsx's mocked-useConfirm pattern so the
confirm dialog's resolution is deterministic without the real ConfirmDialogProvider/portal.
Most tests pass confirmWrites={false} to assert the unconfirmed dispatch path directly; delete
always shows a confirm regardless of confirmWrites, so mockConfirm still gates it.
*/
const mockConfirm = vi.fn<(options: unknown) => Promise<boolean>>();
vi.mock("@fusion/dashboard/app/hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: mockConfirm }),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function milestone(overrides: Record<string, unknown> = {}) {
  return {
    number: 1,
    title: "v1",
    state: "open",
    description: null,
    openIssues: 0,
    closedIssues: 0,
    dueOn: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockConfirm.mockReset();
  mockConfirm.mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MilestonesPanel — no-repo state", () => {
  it("renders the neutral empty state and issues no list fetch when repo is null", () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    render(<MilestonesPanel repo={null} />);
    expect(screen.getByTestId("milestones-panel-no-repo")).toBeInTheDocument();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("MilestonesPanel — data states", () => {
  it("renders a loading state, then the empty state for a repo with zero milestones", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true, repo: "acme/widgets", items: [] })));
    render(<MilestonesPanel repo="acme/widgets" confirmWrites={false} />);
    expect(await screen.findByTestId("milestones-panel-empty")).toBeInTheDocument();
  });

  it("renders an error state when the list request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: false, error: "boom" }, 500)));
    render(<MilestonesPanel repo="acme/widgets" confirmWrites={false} />);
    expect(await screen.findByTestId("milestones-panel-error")).toHaveTextContent("boom");
  });
});

describe("MilestonesPanel — progress percentage (acceptance-critical)", () => {
  it("equals closed/(open+closed) for a populated milestone", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true, repo: "acme/widgets", items: [milestone({ number: 1, openIssues: 1, closedIssues: 3 })] })));
    render(<MilestonesPanel repo="acme/widgets" confirmWrites={false} />);
    // 3 closed / 4 total = 75%.
    await waitFor(() => expect(screen.getByTestId("milestone-progress-label-1")).toHaveTextContent("75%"));
    expect(screen.getByTestId("milestone-progress-label-1")).toHaveTextContent("3/4 closed");
  });

  it("renders a defined 0%/'No issues' state for a total-0 milestone, never NaN%", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true, repo: "acme/widgets", items: [milestone({ number: 2, openIssues: 0, closedIssues: 0 })] })));
    render(<MilestonesPanel repo="acme/widgets" confirmWrites={false} />);
    const label = await screen.findByTestId("milestone-progress-label-2");
    expect(label).toHaveTextContent("No issues");
    expect(label.textContent).not.toContain("NaN");
  });
});

describe("MilestonesPanel — overdue flag (acceptance-critical)", () => {
  it("flags ON for an open past-due milestone", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true, repo: "acme/widgets", items: [milestone({ number: 3, state: "open", dueOn: "2020-01-01T00:00:00Z" })] })));
    render(<MilestonesPanel repo="acme/widgets" confirmWrites={false} />);
    expect(await screen.findByTestId("milestone-overdue-3")).toBeInTheDocument();
  });

  it("flags OFF for a closed past-due milestone", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true, repo: "acme/widgets", items: [milestone({ number: 4, state: "closed", dueOn: "2020-01-01T00:00:00Z" })] })));
    render(<MilestonesPanel repo="acme/widgets" confirmWrites={false} />);
    await screen.findByTestId("milestone-row-4");
    expect(screen.queryByTestId("milestone-overdue-4")).not.toBeInTheDocument();
  });

  it("flags OFF for a milestone with no due date, even when open", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true, repo: "acme/widgets", items: [milestone({ number: 5, state: "open", dueOn: null })] })));
    render(<MilestonesPanel repo="acme/widgets" confirmWrites={false} />);
    await screen.findByTestId("milestone-row-5");
    expect(screen.queryByTestId("milestone-overdue-5")).not.toBeInTheDocument();
    expect(screen.getByText("No due date")).toBeInTheDocument();
  });
});

describe("MilestonesPanel — close-with-open-issues prompt (acceptance-critical)", () => {
  it("opens the how-to-handle prompt with the open-issue count and reassignment options when closing a milestone with open issues", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true, repo: "acme/widgets", items: [milestone({ number: 6, state: "open", openIssues: 3, closedIssues: 1 })] })));
    render(<MilestonesPanel repo="acme/widgets" confirmWrites={false} />);
    await screen.findByTestId("milestone-row-6");

    fireEvent.click(screen.getByTestId("milestone-close-6"));

    const prompt = await screen.findByTestId("milestone-close-prompt-6");
    expect(prompt).toHaveTextContent("3 open issues");
    expect(screen.getByTestId("milestone-reassign-keep-6")).toBeInTheDocument();
    expect(screen.getByTestId("milestone-reassign-clear-6")).toBeInTheDocument();
    expect(screen.getByTestId("milestone-reassign-move-6")).toBeInTheDocument();
    // The state route was NOT dispatched merely by opening the prompt.
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some((call) => String(call[0]).includes("/milestones/state"))).toBe(false);
  });

  it("closes directly WITHOUT the prompt when the milestone has zero open issues", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/milestones/list")) return jsonResponse({ ok: true, repo: "acme/widgets", items: [milestone({ number: 7, state: "open", openIssues: 0, closedIssues: 5 })] });
      if (url.includes("/milestones/state")) return jsonResponse({ ok: true, repo: "acme/widgets", milestone: milestone({ number: 7, state: "closed", openIssues: 0, closedIssues: 5 }) });
      return jsonResponse({ ok: false, error: "unexpected" }, 404);
    });
    vi.stubGlobal("fetch", fetchImpl);
    render(<MilestonesPanel repo="acme/widgets" confirmWrites={false} />);
    await screen.findByTestId("milestone-row-7");

    fireEvent.click(screen.getByTestId("milestone-close-7"));

    expect(screen.queryByTestId("milestone-close-prompt-7")).not.toBeInTheDocument();
    await waitFor(() => expect(fetchImpl.mock.calls.some((call) => String(call[0]).includes("/milestones/state"))).toBe(true));
  });

  it("dispatches reassign-open-issues before close when the operator chooses to clear the milestone", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/milestones/list")) return jsonResponse({ ok: true, repo: "acme/widgets", items: [milestone({ number: 8, state: "open", openIssues: 2, closedIssues: 0 })] });
      if (url.includes("/milestones/reassign-open-issues")) {
        expect(JSON.parse(init?.body as string)).toMatchObject({ number: 8, target: null });
        return jsonResponse({ ok: true, repo: "acme/widgets", reassignedCount: 2 });
      }
      if (url.includes("/milestones/state")) return jsonResponse({ ok: true, repo: "acme/widgets", milestone: milestone({ number: 8, state: "closed" }) });
      return jsonResponse({ ok: false, error: "unexpected" }, 404);
    });
    vi.stubGlobal("fetch", fetchImpl);
    render(<MilestonesPanel repo="acme/widgets" confirmWrites={false} />);
    await screen.findByTestId("milestone-row-8");

    fireEvent.click(screen.getByTestId("milestone-close-8"));
    await screen.findByTestId("milestone-close-prompt-8");
    fireEvent.click(screen.getByTestId("milestone-reassign-clear-8"));
    fireEvent.click(screen.getByTestId("milestone-close-prompt-confirm-8"));

    await waitFor(() => expect(calls.some((url) => url.includes("/milestones/state"))).toBe(true));
    const reassignIndex = calls.findIndex((url) => url.includes("/milestones/reassign-open-issues"));
    const stateIndex = calls.findIndex((url) => url.includes("/milestones/state"));
    expect(reassignIndex).toBeGreaterThanOrEqual(0);
    expect(stateIndex).toBeGreaterThan(reassignIndex);
  });
});

describe("MilestonesPanel — confirm-writes gate", () => {
  it("create includes the confirmation payload when confirm-writes is on", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/milestones/list")) return jsonResponse({ ok: true, repo: "acme/widgets", items: [] });
      if (url.includes("/milestones/create")) {
        expect(JSON.parse(init?.body as string)).toMatchObject({ confirmed: true, title: "v2" });
        return jsonResponse({ ok: true, repo: "acme/widgets", milestone: milestone({ number: 2, title: "v2" }) });
      }
      return jsonResponse({ ok: false, error: "unexpected" }, 404);
    });
    vi.stubGlobal("fetch", fetchImpl);
    mockConfirm.mockResolvedValue(true);

    render(<MilestonesPanel repo="acme/widgets" confirmWrites />);
    await screen.findByTestId("milestones-panel-empty");

    fireEvent.change(screen.getByTestId("milestones-create-title"), { target: { value: "v2" } });
    fireEvent.click(screen.getByTestId("milestones-create-submit"));

    await waitFor(() => expect(fetchImpl.mock.calls.some((call) => String(call[0]).includes("/milestones/create"))).toBe(true));
  });

  it("create: cancel performs zero mutations", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/milestones/list")) return jsonResponse({ ok: true, repo: "acme/widgets", items: [] });
      return jsonResponse({ ok: false, error: "unexpected" }, 404);
    });
    vi.stubGlobal("fetch", fetchImpl);
    mockConfirm.mockResolvedValue(false);

    render(<MilestonesPanel repo="acme/widgets" confirmWrites />);
    await screen.findByTestId("milestones-panel-empty");

    fireEvent.change(screen.getByTestId("milestones-create-title"), { target: { value: "v2" } });
    fireEvent.click(screen.getByTestId("milestones-create-submit"));

    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    expect(fetchImpl.mock.calls.some((call) => String(call[0]).includes("/milestones/create"))).toBe(false);
  });

  it("delete always shows an explicit confirm affordance and includes the confirmation payload when confirm-writes is on", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/milestones/list")) return jsonResponse({ ok: true, repo: "acme/widgets", items: [milestone({ number: 9 })] });
      if (url.includes("/milestones/delete")) {
        expect(JSON.parse(init?.body as string)).toMatchObject({ confirmed: true, number: 9 });
        return jsonResponse({ ok: true, repo: "acme/widgets", number: 9 });
      }
      return jsonResponse({ ok: false, error: "unexpected" }, 404);
    });
    vi.stubGlobal("fetch", fetchImpl);
    mockConfirm.mockResolvedValue(true);

    render(<MilestonesPanel repo="acme/widgets" confirmWrites />);
    await screen.findByTestId("milestone-row-9");

    fireEvent.click(screen.getByTestId("milestone-delete-9"));

    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    await waitFor(() => expect(fetchImpl.mock.calls.some((call) => String(call[0]).includes("/milestones/delete"))).toBe(true));
  });
});
