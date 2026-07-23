import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { GitHubPmView } from "../GitHubPmView.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("GitHubPmView", () => {
  it("renders the not-configured status badge for an empty settings state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true, configured: false, autonomy: "approve-all", defaultRepo: null })));
    render(<GitHubPmView context={{ projectId: "proj-1" } as any} />);
    expect(await screen.findByText("Not configured")).toBeInTheDocument();
    expect(screen.getByText(/Add a default repository or personal access token/i)).toBeInTheDocument();
  });

  it("renders the configured status badge and default repo/autonomy without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true, configured: true, autonomy: "suggest", defaultRepo: "acme/widgets" })));
    render(<GitHubPmView context={{ projectId: "proj-1" } as any} />);
    expect(await screen.findByText("GitHub PM configured")).toBeInTheDocument();
    expect(screen.getByText(/acme\/widgets/i)).toBeInTheDocument();
    expect(screen.getByText(/suggest/i)).toBeInTheDocument();
  });

  it("never renders a PAT value even if leaked into the response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true, configured: true, autonomy: "auto", defaultRepo: "acme/widgets", personalAccessToken: "ghp_should_never_render" })));
    render(<GitHubPmView context={{ projectId: "proj-1" } as any} />);
    await screen.findByText("GitHub PM configured");
    expect(screen.queryByText(/ghp_should_never_render/)).not.toBeInTheDocument();
  });

  it("renders an error status when the status request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: false, error: "boom" }, 500)));
    render(<GitHubPmView context={{ projectId: "proj-1" } as any} />);
    expect(await screen.findByText("boom")).toBeInTheDocument();
  });
});
