import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AuthDiagnosticsPanel } from "../AuthDiagnosticsPanel.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AuthDiagnosticsPanel", () => {
  it("renders all-capabilities-supported state with no warning", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          ok: true,
          authenticated: true,
          source: "gh-cli",
          introspectable: true,
          probeStatus: "ok",
          capabilities: { issues: "supported", discussions: "supported", projects: "supported" },
          missingProjectScope: false,
        }),
      ),
    );
    render(<AuthDiagnosticsPanel context={{ projectId: "proj-1" } as any} />);
    expect(await screen.findByText(/Authenticated via GitHub CLI/i)).toBeInTheDocument();
    expect(screen.getAllByText("Supported")).toHaveLength(3);
    expect(screen.queryByTestId("auth-diagnostics-project-warning")).not.toBeInTheDocument();
  });

  it("renders the project-missing actionable warning with instructions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          ok: true,
          authenticated: true,
          source: "pat",
          introspectable: true,
          probeStatus: "ok",
          capabilities: { issues: "supported", discussions: "supported", projects: "missing" },
          missingProjectScope: true,
          warning: {
            message: "This token lacks the 'project' scope, so Projects v2 boards are unavailable.",
            instructions: ["Open https://github.com/settings/tokens and edit or create a personal access token."],
          },
        }),
      ),
    );
    render(<AuthDiagnosticsPanel context={{ projectId: "proj-1" } as any} />);
    const warning = await screen.findByTestId("auth-diagnostics-project-warning");
    expect(warning).toHaveTextContent(/lacks the 'project' scope/i);
    expect(warning).toHaveTextContent(/github\.com\/settings\/tokens/i);
  });

  it("renders the scopes-unknown state for a fine-grained token without falsely claiming project is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          ok: true,
          authenticated: true,
          source: "pat",
          introspectable: false,
          probeStatus: "non-introspectable",
          capabilities: { issues: "unknown", discussions: "unknown", projects: "unknown" },
          missingProjectScope: false,
        }),
      ),
    );
    render(<AuthDiagnosticsPanel context={{ projectId: "proj-1" } as any} />);
    expect(await screen.findByTestId("auth-diagnostics-non-introspectable")).toHaveTextContent(/cannot be read/i);
    expect(screen.getAllByText("Unknown")).toHaveLength(3);
    expect(screen.queryByTestId("auth-diagnostics-project-warning")).not.toBeInTheDocument();
  });

  it("renders not-authenticated guidance (gh login, env var, or PAT) with no separate OAuth login button", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          ok: true,
          authenticated: false,
          source: "none",
          introspectable: false,
          probeStatus: "skipped",
          capabilities: { issues: "unknown", discussions: "unknown", projects: "unknown" },
          missingProjectScope: false,
          warning: {
            message: "GitHub PM is not authenticated.",
            instructions: [
              "Run 'gh auth login' to authenticate the GitHub CLI, or",
              "Set the GITHUB_TOKEN environment variable, or",
              "Add a personal access token in Plugin Manager settings (Authentication group).",
            ],
          },
        }),
      ),
    );
    render(<AuthDiagnosticsPanel context={{ projectId: "proj-1" } as any} />);
    expect(await screen.findByTestId("auth-diagnostics-unauthenticated")).toHaveTextContent(/not authenticated/i);
    expect(screen.getByText(/gh auth login/i)).toBeInTheDocument();
    expect(screen.getByText(/GITHUB_TOKEN/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /log in with github/i })).not.toBeInTheDocument();
  });

  it("degrades without crashing when the diagnostics probe request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: false, error: "network down" }, 500)));
    render(<AuthDiagnosticsPanel context={{ projectId: "proj-1" } as any} />);
    expect(await screen.findByTestId("auth-diagnostics-degraded")).toHaveTextContent(/network down/i);
  });

  it("never renders a raw PAT value even if leaked into the response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          ok: true,
          authenticated: true,
          source: "pat",
          introspectable: true,
          probeStatus: "ok",
          capabilities: { issues: "supported", discussions: "supported", projects: "supported" },
          missingProjectScope: false,
          personalAccessToken: "ghp_should_never_render",
        }),
      ),
    );
    render(<AuthDiagnosticsPanel context={{ projectId: "proj-1" } as any} />);
    await screen.findByText(/Authenticated via/i);
    expect(screen.queryByText(/ghp_should_never_render/)).not.toBeInTheDocument();
  });
});
