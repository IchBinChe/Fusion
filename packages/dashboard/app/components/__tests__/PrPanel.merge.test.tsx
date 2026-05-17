import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PrPanel } from "../PrPanel";

vi.mock("../../api", () => ({
  refreshPrStatus: vi.fn(),
  fetchPrChecks: vi.fn().mockResolvedValue({ checks: [], rollup: "unknown", lastCheckedAt: new Date().toISOString() }),
  fetchPrReviews: vi.fn().mockResolvedValue({ snapshot: { decision: null, items: [] }, comments: [] }),
  mergePr: vi.fn().mockResolvedValue({ prInfo: { url: "https://github.com/o/r/pull/1", number: 1, status: "merged", title: "t", headBranch: "h", baseBranch: "main", commentCount: 0 } }),
  setAutoMergeOnGreen: vi.fn().mockResolvedValue({ prInfo: { url: "https://github.com/o/r/pull/1", number: 1, status: "open", title: "t", headBranch: "h", baseBranch: "main", commentCount: 0, autoMergeOnGreen: true } }),
}));

describe("PrPanel merge controls", () => {
  it.each([
    [{ status: "open", draft: false }, true],
    [{ status: "open", draft: true }, false],
    [{ status: "merged", draft: false }, false],
  ] as const)("shows merge controls matrix %#", (state, expected) => {
    render(<PrPanel taskId="FN-1" prAuthAvailable onPrUpdated={() => {}} addToast={() => {}} prInfo={{ url: "https://github.com/o/r/pull/1", number: 1, title: "t", headBranch: "h", baseBranch: "main", commentCount: 0, ...state }} />);
    expect(screen.queryByText("Merge pull request") !== null).toBe(expected);
  });

  it("shows merged banner", () => {
    render(<PrPanel taskId="FN-1" prAuthAvailable onPrUpdated={() => {}} addToast={() => {}} prInfo={{ url: "https://github.com/o/r/pull/1", number: 1, status: "merged", title: "t", headBranch: "h", baseBranch: "main", commentCount: 0 }} />);
    expect(screen.getByText("Merged — task moved to Done")).toBeInTheDocument();
  });

  it("shows error block and retry", () => {
    render(<PrPanel taskId="FN-1" prAuthAvailable onPrUpdated={() => {}} addToast={() => {}} prInfo={{ url: "https://github.com/o/r/pull/1", number: 1, status: "open", title: "t", headBranch: "h", baseBranch: "main", commentCount: 0, lastMergeError: "boom" }} />);
    expect(screen.getByText("boom")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  });
});
