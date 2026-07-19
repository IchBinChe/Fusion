import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReportModal } from "../ReportModal";
import * as api from "../../api";
import * as capture from "../../utils/report-capture";

vi.mock("../../api", () => ({
  reportAttachment: vi.fn(),
  reportDraft: vi.fn(),
  reportFile: vi.fn(),
  reportHelp: vi.fn(),
}));
vi.mock("../../utils/report-capture", () => ({
  captureScreenshot: vi.fn(),
  getRecentActivity: vi.fn(() => []),
  recordActivity: vi.fn(),
}));

const reportAttachment = vi.mocked(api.reportAttachment);
const reportDraft = vi.mocked(api.reportDraft);
const reportFile = vi.mocked(api.reportFile);
const captureScreenshot = vi.mocked(capture.captureScreenshot);

describe("ReportModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captureScreenshot.mockResolvedValue(new Blob(["png"], { type: "image/png" }));
  });

  it("uploads an opted-in screenshot and sends its reference only after retention confirmation", async () => {
    reportAttachment.mockResolvedValueOnce({ artifactId: "123e4567-e89b-42d3-a456-426614174000" });
    reportDraft.mockResolvedValueOnce({ kind: "draft-ready", report: { userPrompt: "It crashes", body: "## Summary\nIt crashes", context: {} } });
    render(<ReportModal actionType="bug" onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("What went wrong?"), { target: { value: "It crashes" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Store a screenshot locally" }));
    const confirmation = await screen.findByRole("checkbox", { name: /I confirm Fusion may retain/ });
    fireEvent.click(confirmation);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(reportDraft).toHaveBeenCalledWith(expect.objectContaining({
      screenshotArtifactId: "123e4567-e89b-42d3-a456-426614174000",
    })));
  });

  it("clears a pending capture when the reporter opts out", async () => {
    let resolveUpload!: (value: { artifactId: string }) => void;
    reportAttachment.mockReturnValueOnce(new Promise((resolve) => { resolveUpload = resolve; }));
    render(<ReportModal actionType="bug" onClose={vi.fn()} />);

    const option = screen.getByRole("checkbox", { name: "Store a screenshot locally" });
    fireEvent.click(option);
    fireEvent.click(option);
    resolveUpload({ artifactId: "123e4567-e89b-42d3-a456-426614174000" });

    await waitFor(() => expect(screen.queryByRole("checkbox", { name: /I confirm Fusion may retain/ })).not.toBeInTheDocument());
    expect(option).not.toBeChecked();
  });

  it("shows an actionable error and retry affordance when preparing a report fails", async () => {
    reportDraft.mockRejectedValueOnce(new Error("offline"));
    render(<ReportModal actionType="bug" onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("What went wrong?"), { target: { value: "It crashes" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("could not prepare");
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();

    reportDraft.mockResolvedValueOnce({ kind: "draft-ready", report: { userPrompt: "It crashes", body: "## Summary\nIt crashes", context: {} } });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(reportDraft).toHaveBeenCalledTimes(2));
  });

  it("preserves an editable draft and makes filing failures retryable", async () => {
    reportDraft.mockResolvedValueOnce({ kind: "draft-ready", report: { userPrompt: "It crashes", body: "## Summary\nIt crashes", context: {} } });
    reportFile.mockRejectedValueOnce(new Error("offline"));
    render(<ReportModal actionType="bug" onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("What went wrong?"), { target: { value: "It crashes" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("Review your report");
    fireEvent.click(screen.getByRole("button", { name: "File report" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("draft is still here");
    expect(screen.getByRole("button", { name: "File report" })).toBeEnabled();
  });

  it("shows an editable draft and requires confirmation before endorsing a duplicate", async () => {
    reportDraft.mockResolvedValueOnce({ kind: "duplicate-found", issue: { number: 22, url: "https://example.test/22", title: "Existing issue" }, report: { userPrompt: "It crashes", body: "## Summary\nIt crashes", context: {} } });
    reportFile.mockResolvedValueOnce({ kind: "endorsed", url: "https://example.test/comments/1" });
    render(<ReportModal actionType="bug" onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("What went wrong?"), { target: { value: "It crashes" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("Review data point for a similar open issue");
    expect(reportFile).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Report summary"), { target: { value: "It crashes after saving" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm and add data point" }));

    await waitFor(() => expect(reportFile).toHaveBeenCalledWith(expect.objectContaining({
      endorseIssueNumber: 22,
      report: expect.objectContaining({ userPrompt: "It crashes after saving" }),
    })));
  });

  it("offers a reviewed endorsement for a roadmap issue", async () => {
    reportDraft.mockResolvedValueOnce({ kind: "duplicate-found", report: { userPrompt: "Keep reports while offline", body: "data" }, issue: { number: 30, title: "Offline report queue", url: "https://example.test/issues/30", roadmap: true } });
    render(<ReportModal actionType="idea" onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("What would you like Fusion to do?"), { target: { value: "Keep reports while offline" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText("Already on the roadmap — add your data point?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm and add data point" }));
    await waitFor(() => expect(reportFile).toHaveBeenCalledWith(expect.objectContaining({ endorseRoadmapIssueNumber: 30 })));
  });

  it("lets people return to the guided prompt after an unavailable response", async () => {
    reportDraft.mockResolvedValueOnce({ kind: "unavailable", message: "GitHub is not connected" });
    render(<ReportModal actionType="feedback" onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("What would you like to share?"), { target: { value: "A thought" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Return to prompt" }));
    expect(screen.getByLabelText("What would you like to share?")).toBeInTheDocument();
  });

  it("keeps the original derivation marker when the review prompt is edited", async () => {
    reportDraft.mockResolvedValueOnce({ kind: "draft-ready", report: { userPrompt: "It crashes", sourcePrompt: "It crashes", body: "## Summary\nIt crashes\n\n## Environment\nCollected context", context: {} } });
    reportFile.mockResolvedValueOnce({ kind: "filed", url: "https://example.test/1" });
    render(<ReportModal actionType="bug" onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("What went wrong?"), { target: { value: "It crashes" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("Review your report");
    fireEvent.change(screen.getByLabelText("Report summary"), { target: { value: "It crashes after saving" } });
    fireEvent.click(screen.getByRole("button", { name: "File report" }));

    await waitFor(() => expect(reportFile).toHaveBeenCalledOnce());
    expect(reportFile).toHaveBeenCalledWith(expect.objectContaining({ report: expect.objectContaining({
      userPrompt: "It crashes after saving",
      sourcePrompt: "It crashes",
      body: expect.stringContaining("## Environment"),
    }) }));
  });
});
