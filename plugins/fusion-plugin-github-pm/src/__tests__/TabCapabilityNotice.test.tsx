import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TabCapabilityNotice } from "../TabCapabilityNotice.js";

afterEach(() => {
  cleanup();
});

describe("TabCapabilityNotice", () => {
  it("renders the Discussions-disabled reason message and fix-path list", () => {
    render(
      <TabCapabilityNotice
        reason="feature-disabled"
        message="Discussions are not enabled for this repository."
        fix={["Ask the repository owner to enable Discussions in the repository's Settings → Features."]}
      />,
    );
    const notice = screen.getByTestId("tab-capability-notice");
    expect(notice).toHaveAttribute("role", "alert");
    expect(notice).toHaveTextContent(/discussions are not enabled/i);
    const fix = screen.getByTestId("tab-capability-fix");
    expect(fix).toHaveTextContent(/enable discussions/i);
    expect(fix).toHaveTextContent(/settings → features/i);
  });

  it("renders the Projects scope-missing reason message and an actionable fix path", () => {
    render(
      <TabCapabilityNotice
        reason="missing-scope"
        message="This token lacks the 'project' scope, so Projects v2 boards are unavailable."
        fix={[
          "Open https://github.com/settings/tokens and edit or create a personal access token.",
          "For a classic PAT, enable the 'project' scope.",
        ]}
      />,
    );
    const notice = screen.getByTestId("tab-capability-notice");
    expect(notice).toHaveTextContent(/lacks the 'project' scope/i);
    const fix = screen.getByTestId("tab-capability-fix");
    expect(fix).toHaveTextContent(/github\.com\/settings\/tokens/i);
    expect(fix).toHaveTextContent(/enable the 'project' scope/i);
  });

  it("renders an informational (non-alert) presentation for the 'unknown' reason", () => {
    render(
      <TabCapabilityNotice
        reason="unknown"
        message="This token's scopes can't be confirmed (fine-grained personal access token). Support is unknown, not confirmed missing."
      />,
    );
    const notice = screen.getByTestId("tab-capability-notice");
    expect(notice).toHaveAttribute("role", "status");
    expect(notice).toHaveTextContent(/can't be confirmed/i);
  });

  it("renders not-authenticated guidance with its fix path", () => {
    render(
      <TabCapabilityNotice
        reason="not-authenticated"
        message="GitHub PM is not authenticated."
        fix={["Run 'gh auth login' to authenticate the GitHub CLI, or", "Set the GITHUB_TOKEN environment variable, or"]}
      />,
    );
    expect(screen.getByTestId("tab-capability-notice")).toHaveTextContent(/not authenticated/i);
    expect(screen.getByTestId("tab-capability-fix")).toHaveTextContent(/gh auth login/i);
  });

  it("renders a repo-access-error notice without leaking a raw API error string", () => {
    const rawApiError = "Repository acme/ghost was not found or is not accessible with the current token.";
    render(
      <TabCapabilityNotice
        reason="repo-access-error"
        message="Could not read this repository's feature settings — it may not exist, or the resolved token lacks access."
        fix={["Verify the repository owner/name is correct.", "Confirm the resolved GitHub token has access to this repository."]}
      />,
    );
    const notice = screen.getByTestId("tab-capability-notice");
    expect(notice).not.toHaveTextContent(rawApiError);
    expect(notice).toHaveTextContent(/could not read this repository/i);
  });

  it("falls back to a generic reason title when no message is supplied", () => {
    render(<TabCapabilityNotice reason="feature-disabled" />);
    expect(screen.getByTestId("tab-capability-notice")).toHaveTextContent(/not enabled for this repository/i);
  });
});
