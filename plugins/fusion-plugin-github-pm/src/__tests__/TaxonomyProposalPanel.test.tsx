import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TaxonomyProposalPanel } from "../TaxonomyProposalPanel.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const DRAFT_PROPOSAL = {
  version: 1,
  generatedAt: "2026-07-24T00:00:00.000Z",
  status: "draft",
  sourceStats: { issueCount: 3, discussionCount: 2, existingLabelCount: 4 },
  labels: [{ name: "bug" }],
  fields: [{ name: "Priority", type: "single-select", options: ["low", "high"] }],
  categories: [{ name: "Bugs" }],
  rationale: "grounded",
};

describe("TaxonomyProposalPanel", () => {
  it("renders disabled guidance when no repo is selected (no propose call made)", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    render(<TaxonomyProposalPanel repo={null} />);

    expect(await screen.findByTestId("taxonomy-no-repo")).toBeInTheDocument();
    const button = screen.getByTestId("taxonomy-propose-button");
    expect(button).toBeDisabled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("renders a coherent empty state for a repo with no proposals yet", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true, repo: "owner/repo", proposals: [], approvedTaxonomyVersion: null })));
    render(<TaxonomyProposalPanel repo="owner/repo" />);

    expect(await screen.findByTestId("taxonomy-empty")).toBeInTheDocument();
    expect(screen.getByTestId("taxonomy-propose-button")).not.toBeDisabled();
  });

  it("renders a draft proposal with Accept/Reject/Edit controls and no Active badge", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true, repo: "owner/repo", proposals: [DRAFT_PROPOSAL], approvedTaxonomyVersion: null })));
    render(<TaxonomyProposalPanel repo="owner/repo" />);

    await screen.findByTestId("taxonomy-proposal-v1");
    expect(screen.getByTestId("taxonomy-accept-v1")).toBeInTheDocument();
    expect(screen.getByTestId("taxonomy-reject-v1")).toBeInTheDocument();
    expect(screen.getByTestId("taxonomy-edit-v1")).toBeInTheDocument();
    expect(screen.getByTestId("taxonomy-badge-draft")).toBeInTheDocument();
    expect(screen.queryByTestId("taxonomy-badge-active")).not.toBeInTheDocument();
  });

  it("renders an accepted proposal with the Active badge and NO Accept/Reject/Edit shells (no orphaned buttons)", async () => {
    const accepted = { ...DRAFT_PROPOSAL, status: "accepted" };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true, repo: "owner/repo", proposals: [accepted], approvedTaxonomyVersion: 1 })));
    render(<TaxonomyProposalPanel repo="owner/repo" />);

    await screen.findByTestId("taxonomy-proposal-v1");
    expect(screen.getByTestId("taxonomy-badge-active")).toBeInTheDocument();
    expect(screen.queryByTestId("taxonomy-accept-v1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("taxonomy-reject-v1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("taxonomy-edit-v1")).not.toBeInTheDocument();
  });

  it("renders a rejected proposal with no action controls", async () => {
    const rejected = { ...DRAFT_PROPOSAL, status: "rejected" };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true, repo: "owner/repo", proposals: [rejected], approvedTaxonomyVersion: null })));
    render(<TaxonomyProposalPanel repo="owner/repo" />);

    await screen.findByTestId("taxonomy-badge-rejected");
    expect(screen.queryByTestId("taxonomy-accept-v1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("taxonomy-reject-v1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("taxonomy-edit-v1")).not.toBeInTheDocument();
  });

  it("Propose calls POST /taxonomy/propose then reloads proposals", async () => {
    let proposeCalled = false;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/taxonomy/propose") && init?.method === "POST") {
        proposeCalled = true;
        return jsonResponse({ ok: true, repo: "owner/repo", proposal: DRAFT_PROPOSAL });
      }
      if (String(url).includes("/taxonomy/proposals")) {
        return jsonResponse({ ok: true, repo: "owner/repo", proposals: proposeCalled ? [DRAFT_PROPOSAL] : [], approvedTaxonomyVersion: null });
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetchImpl);
    render(<TaxonomyProposalPanel repo="owner/repo" />);

    await screen.findByTestId("taxonomy-empty");
    fireEvent.click(screen.getByTestId("taxonomy-propose-button"));

    await waitFor(() => expect(screen.getByTestId("taxonomy-proposal-v1")).toBeInTheDocument());
    expect(fetchImpl.mock.calls.some((call) => String(call[0]).includes("/taxonomy/propose"))).toBe(true);
  });

  it("Accept calls PUT /taxonomy/proposals/accept with the repo and version", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/taxonomy/proposals/accept")) {
        return jsonResponse({ ok: true, repo: "owner/repo", proposal: { ...DRAFT_PROPOSAL, status: "accepted" }, approvedTaxonomyVersion: 1 });
      }
      return jsonResponse({ ok: true, repo: "owner/repo", proposals: [DRAFT_PROPOSAL], approvedTaxonomyVersion: null });
    });
    vi.stubGlobal("fetch", fetchImpl);
    render(<TaxonomyProposalPanel repo="owner/repo" />);

    await screen.findByTestId("taxonomy-accept-v1");
    fireEvent.click(screen.getByTestId("taxonomy-accept-v1"));

    await waitFor(() => {
      const acceptCall = fetchImpl.mock.calls.find((call) => String(call[0]).includes("/taxonomy/proposals/accept"));
      expect(acceptCall).toBeTruthy();
      const body = JSON.parse(String((acceptCall![1] as RequestInit).body));
      expect(body).toEqual({ repo: "owner/repo", version: 1 });
    });
  });

  it("Reject calls PUT /taxonomy/proposals/reject with the repo and version", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes("/taxonomy/proposals/reject")) {
        return jsonResponse({ ok: true, repo: "owner/repo", proposal: { ...DRAFT_PROPOSAL, status: "rejected" } });
      }
      return jsonResponse({ ok: true, repo: "owner/repo", proposals: [DRAFT_PROPOSAL], approvedTaxonomyVersion: null });
    });
    vi.stubGlobal("fetch", fetchImpl);
    render(<TaxonomyProposalPanel repo="owner/repo" />);

    await screen.findByTestId("taxonomy-reject-v1");
    fireEvent.click(screen.getByTestId("taxonomy-reject-v1"));

    await waitFor(() => {
      expect(fetchImpl.mock.calls.some((call) => String(call[0]).includes("/taxonomy/proposals/reject"))).toBe(true);
    });
  });

  it("Edit opens an editable form and Save calls PUT /taxonomy/proposals/edit", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes("/taxonomy/proposals/edit")) {
        return jsonResponse({ ok: true, repo: "owner/repo", proposal: { ...DRAFT_PROPOSAL, rationale: "manual edit" } });
      }
      return jsonResponse({ ok: true, repo: "owner/repo", proposals: [DRAFT_PROPOSAL], approvedTaxonomyVersion: null });
    });
    vi.stubGlobal("fetch", fetchImpl);
    render(<TaxonomyProposalPanel repo="owner/repo" />);

    await screen.findByTestId("taxonomy-edit-v1");
    fireEvent.click(screen.getByTestId("taxonomy-edit-v1"));

    const textarea = await screen.findByLabelText(/rationale/i);
    fireEvent.change(textarea, { target: { value: "manual edit" } });
    fireEvent.click(screen.getByRole("button", { name: /save edit/i }));

    await waitFor(() => {
      const editCall = fetchImpl.mock.calls.find((call) => String(call[0]).includes("/taxonomy/proposals/edit"));
      expect(editCall).toBeTruthy();
      const body = JSON.parse(String((editCall![1] as RequestInit).body));
      expect(body.proposal.rationale).toBe("manual edit");
    });
  });

  it("surfaces an inline error without crashing when propose fails", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/taxonomy/propose") && init?.method === "POST") {
        return jsonResponse({ ok: false, error: "AI session factory unavailable" }, 502);
      }
      return jsonResponse({ ok: true, repo: "owner/repo", proposals: [], approvedTaxonomyVersion: null });
    });
    vi.stubGlobal("fetch", fetchImpl);
    render(<TaxonomyProposalPanel repo="owner/repo" />);

    await screen.findByTestId("taxonomy-empty");
    fireEvent.click(screen.getByTestId("taxonomy-propose-button"));

    expect(await screen.findByTestId("taxonomy-error")).toHaveTextContent(/AI session factory unavailable/i);
  });
});
