import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { GitHubPmView } from "../GitHubPmView.js";

interface MockRoutes {
  status: unknown;
  statusStatus?: number;
  repoConfig?: unknown;
  repoConfigStatus?: number;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function mockFetch({ status, statusStatus = 200, repoConfig = { ok: true, selectedRepo: null }, repoConfigStatus = 200 }: MockRoutes) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/repo-config")) return jsonResponse(repoConfig, repoConfigStatus);
    return jsonResponse(status, statusStatus);
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("GitHubPmView", () => {
  it("renders the not-configured status badge for an empty settings state", async () => {
    vi.stubGlobal("fetch", mockFetch({ status: { ok: true, configured: false, autonomy: "approve-all", defaultRepo: null } }));
    render(<GitHubPmView context={{ projectId: "proj-1" } as any} />);
    expect(await screen.findByText("Not configured")).toBeInTheDocument();
    expect(screen.getByText(/Add a default repository or personal access token/i)).toBeInTheDocument();
  });

  it("renders the configured status badge and default repo/autonomy without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({ status: { ok: true, configured: true, autonomy: "suggest", defaultRepo: "acme/widgets" } }),
    );
    render(<GitHubPmView context={{ projectId: "proj-1" } as any} />);
    expect(await screen.findByText("GitHub PM configured")).toBeInTheDocument();
    expect(await screen.findByText(/acme\/widgets/i)).toBeInTheDocument();
    expect(screen.getByText(/suggest/i)).toBeInTheDocument();
  });

  it("never renders a PAT value even if leaked into the response", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        status: { ok: true, configured: true, autonomy: "auto", defaultRepo: "acme/widgets", personalAccessToken: "ghp_should_never_render" },
      }),
    );
    render(<GitHubPmView context={{ projectId: "proj-1" } as any} />);
    await screen.findByText("GitHub PM configured");
    expect(screen.queryByText(/ghp_should_never_render/)).not.toBeInTheDocument();
  });

  it("renders an error status when the status request fails", async () => {
    vi.stubGlobal("fetch", mockFetch({ status: { ok: false, error: "boom" }, statusStatus: 500 }));
    render(<GitHubPmView context={{ projectId: "proj-1" } as any} />);
    expect(await screen.findByText("boom")).toBeInTheDocument();
  });

  it("renders the selected repository in the repo-context header when populated", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        status: { ok: true, configured: true, autonomy: "approve-all", defaultRepo: null },
        repoConfig: { ok: true, selectedRepo: "octo/hello-world" },
      }),
    );
    render(<GitHubPmView context={{ projectId: "proj-1" } as any} />);
    expect(await screen.findByTestId("github-pm-repo-context-selected")).toHaveTextContent("octo/hello-world");
  });

  it("renders a 'no repository selected' state when nothing is selected or defaulted", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        status: { ok: true, configured: false, autonomy: "approve-all", defaultRepo: null },
        repoConfig: { ok: true, selectedRepo: null },
      }),
    );
    render(<GitHubPmView context={{ projectId: "proj-1" } as any} />);
    expect(await screen.findByTestId("github-pm-repo-context-empty")).toHaveTextContent("No repository selected");
  });

  it("renders all six tabs and preserves an unrelated tab's local state across a switch away and back", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        status: { ok: true, configured: true, autonomy: "approve-all", defaultRepo: "acme/widgets" },
      }),
    );
    render(<GitHubPmView context={{ projectId: "proj-1" } as any} />);
    await screen.findByText("GitHub PM configured");

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(6);

    // Issues panel is active by default; mark a DOM node inside it so we can prove it never unmounts.
    const issuesPanel = screen.getByTestId("github-pm-panel-issues");
    issuesPanel.setAttribute("data-probe", "still-here");

    fireEvent.click(screen.getByRole("tab", { name: /labels/i }));
    expect(screen.getByRole("tab", { name: /labels/i })).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByRole("tab", { name: /issues/i }));
    const issuesPanelAgain = screen.getByTestId("github-pm-panel-issues");
    expect(issuesPanelAgain.getAttribute("data-probe")).toBe("still-here");
  });

  it("keeps inactive tab panels mounted (hidden, not removed) so no orphaned state is lost", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        status: { ok: true, configured: true, autonomy: "approve-all", defaultRepo: "acme/widgets" },
      }),
    );
    render(<GitHubPmView context={{ projectId: "proj-1" } as any} />);
    await screen.findByText("GitHub PM configured");

    fireEvent.click(screen.getByRole("tab", { name: /triage/i }));
    // All six panels stay in the DOM (mounted-but-hidden); getAllByRole with hidden:true finds every panel.
    const allPanels = screen.getAllByRole("tabpanel", { hidden: true });
    expect(allPanels).toHaveLength(6);
    const issuesPanel = screen.getByTestId("github-pm-panel-issues");
    expect(issuesPanel).toHaveAttribute("hidden");
  });
});
