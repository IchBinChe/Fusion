import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { GITHUB_PM_TABS, GitHubPmTabs, type GitHubPmTabId } from "../GitHubPmTabs.js";

afterEach(() => {
  cleanup();
});

function Harness({ initial = "issues" as GitHubPmTabId, tabs = GITHUB_PM_TABS }: { initial?: GitHubPmTabId; tabs?: typeof GITHUB_PM_TABS }) {
  const [active, setActive] = useState<GitHubPmTabId>(initial);
  return <GitHubPmTabs tabs={tabs} activeTab={active} onChange={setActive} />;
}

describe("GitHubPmTabs", () => {
  it("renders all six declared tabs with role=tablist/tab", () => {
    render(<Harness />);
    expect(screen.getByRole("tablist", { name: /github pm surfaces/i })).toBeInTheDocument();
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(6);
    expect(tabs.map((t) => t.textContent)).toEqual(
      expect.arrayContaining(["Issues", "Labels", "Milestones", "Discussions", "Projects", "Triage"]),
    );
  });

  it("marks exactly one tab active via aria-selected", () => {
    render(<Harness />);
    const selected = screen.getAllByRole("tab").filter((t) => t.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveTextContent("Issues");
  });

  it("switches the active tab on click", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("tab", { name: /labels/i }));
    expect(screen.getByRole("tab", { name: /labels/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /issues/i })).toHaveAttribute("aria-selected", "false");
  });

  it("switches the active tab via ArrowRight keyboard navigation", () => {
    render(<Harness />);
    const issuesTab = screen.getByRole("tab", { name: /issues/i });
    issuesTab.focus();
    fireEvent.keyDown(issuesTab, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: /labels/i })).toHaveAttribute("aria-selected", "true");
  });

  it("wraps to the first tab from the last via ArrowRight, and supports Home/End", () => {
    render(<Harness initial="triage" />);
    const triageTab = screen.getByRole("tab", { name: /triage/i });
    triageTab.focus();
    fireEvent.keyDown(triageTab, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: /issues/i })).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(screen.getByRole("tab", { name: /issues/i }), { key: "End" });
    expect(screen.getByRole("tab", { name: /triage/i })).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(screen.getByRole("tab", { name: /triage/i }), { key: "Home" });
    expect(screen.getByRole("tab", { name: /issues/i })).toHaveAttribute("aria-selected", "true");
  });

  it("does not select a disabled tab on click and surfaces its disabledReason", () => {
    const onChange = vi.fn();
    const tabs = GITHUB_PM_TABS.map((tab) => (tab.id === "projects" ? { ...tab, disabled: true, disabledReason: "Select a repository first" } : tab));
    render(<GitHubPmTabs tabs={tabs} activeTab="issues" onChange={onChange} />);

    const projectsTab = screen.getByRole("tab", { name: /projects/i });
    expect(projectsTab).toBeDisabled();
    expect(projectsTab).toHaveAttribute("aria-disabled", "true");
    expect(projectsTab).toHaveAttribute("title", "Select a repository first");

    fireEvent.click(projectsTab);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("skips disabled tabs during keyboard navigation", () => {
    const tabs = GITHUB_PM_TABS.map((tab) => (tab.id === "labels" ? { ...tab, disabled: true, disabledReason: "unavailable" } : tab));
    render(<Harness tabs={tabs} />);
    const issuesTab = screen.getByRole("tab", { name: /issues/i });
    issuesTab.focus();
    fireEvent.keyDown(issuesTab, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: /milestones/i })).toHaveAttribute("aria-selected", "true");
  });
});
