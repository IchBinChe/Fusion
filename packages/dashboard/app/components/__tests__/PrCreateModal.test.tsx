import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { act } from "react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PrCreateModal } from "../PrCreateModal";
import type { PrInfo } from "@fusion/core";

const mocks = vi.hoisted(() => ({
  generatePrMetadata: vi.fn(),
  fetchPrPreflight: vi.fn(),
  fetchPrOptions: vi.fn(),
  createPr: vi.fn(),
  pushPrBranch: vi.fn(),
  resolvePrConflicts: vi.fn(),
}));

vi.mock("../../api", () => ({
  generatePrMetadata: mocks.generatePrMetadata,
  fetchPrPreflight: mocks.fetchPrPreflight,
  fetchPrOptions: mocks.fetchPrOptions,
  createPr: mocks.createPr,
  pushPrBranch: mocks.pushPrBranch,
  resolvePrConflicts: mocks.resolvePrConflicts,
}));

const metadata = { title: "AI title", body: "## Summary\n\n## Changes\n\n## Testing\n\n## Linked Task\n", templateUsed: true };
const preflight = {
  branchOnRemote: true,
  commitsPresent: true,
  conflictsWithBase: false,
  ghAuthOk: true,
  defaultBaseBranch: "main",
  head: "fusion/FN-4756",
  commits: [{ sha: "abcdef1", subject: "feat", author: "dev" }],
  changedFiles: [{ path: "a.ts", additions: 1, deletions: 0, status: "modified" as const }],
};
const options = {
  baseBranches: ["main", "develop"],
  reviewers: [{ login: "rev1", name: "Reviewer 1" }],
  assignees: [{ login: "assign1", name: "Assignee 1" }],
  labels: [{ name: "bug", color: "ff0000" }],
};

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderModal(overrides?: Partial<ComponentProps<typeof PrCreateModal>>) {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  const addToast = vi.fn();
  render(
    <PrCreateModal
      open
      taskId="FN-4756"
      onClose={onClose}
      onCreated={onCreated}
      addToast={addToast}
      {...overrides}
    />,
  );
  return { onClose, onCreated, addToast };
}

async function renderModalLoaded(overrides?: Partial<ComponentProps<typeof PrCreateModal>>) {
  const handles = renderModal(overrides);
  await screen.findByDisplayValue("AI title");
  return handles;
}

describe("PrCreateModal", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mocks.generatePrMetadata.mockResolvedValue(metadata);
    mocks.fetchPrPreflight.mockResolvedValue(preflight);
    mocks.fetchPrOptions.mockResolvedValue(options);
    mocks.createPr.mockResolvedValue({ number: 12, title: "AI title", url: "url", status: "open", headBranch: "h", baseBranch: "main", commentCount: 0 } as PrInfo);
    mocks.pushPrBranch.mockResolvedValue({ result: { pushed: true, head: "fusion/fn-4756", message: "Pushed fusion/fn-4756 to origin." }, preflight });
    mocks.resolvePrConflicts.mockResolvedValue({ result: { resolved: true, pushed: true, conflictedFiles: ["a.ts"], message: "resolved" }, preflight });
  });

  it("renders nothing when closed", () => {
    render(<PrCreateModal open={false} taskId="FN-4756" onClose={vi.fn()} onCreated={vi.fn()} addToast={vi.fn()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("portals out of a container-type containing block", async () => {
    const { container } = render(
      <div data-testid="trap" style={{ containerType: "inline-size" }}>
        <PrCreateModal open taskId="FN-4756" onClose={vi.fn()} onCreated={vi.fn()} addToast={vi.fn()} />
      </div>,
    );

    await screen.findByDisplayValue("AI title");

    const trap = within(container).getByTestId("trap");
    expect(trap.querySelector('[role="dialog"]')).toBeNull();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(dialog.parentElement).toHaveClass("modal-overlay", "open");
    expect(dialog.parentElement?.parentElement).toBe(document.body);
  });

  it("portals independently of an outer modal overlay", async () => {
    const outerOnClose = vi.fn();
    const innerOnClose = vi.fn();

    const { container } = render(
      <div>
        <div className="modal-overlay open" data-testid="outer-overlay" onClick={outerOnClose}>
          <div className="modal" role="dialog" aria-modal="true" aria-label="Outer modal">Outer modal</div>
        </div>
        <div data-testid="outer-shell">
          <PrCreateModal open taskId="FN-4756" onClose={innerOnClose} onCreated={vi.fn()} addToast={vi.fn()} />
        </div>
      </div>,
    );

    await screen.findByDisplayValue("AI title");

    const outerShell = within(container).getByTestId("outer-shell");
    expect(outerShell.querySelector('[role="dialog"]')).toBeNull();

    const overlays = Array.from(document.body.querySelectorAll(".modal-overlay.open"));
    expect(overlays).toHaveLength(2);

    const outerOverlay = within(container).getByTestId("outer-overlay");
    const innerDialog = screen.getByRole("dialog", { name: "Create Pull Request" });
    expect(outerOverlay.contains(innerDialog)).toBe(false);

    fireEvent.click(outerOverlay);
    expect(outerOnClose).toHaveBeenCalledTimes(1);
    expect(innerOnClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Create Pull Request" })).toBeInTheDocument();
  });

  it("loads metadata/preflight/options on open and renders key sections", async () => {
    renderModal();
    await waitFor(() => {
      expect(mocks.generatePrMetadata).toHaveBeenCalledTimes(1);
      expect(mocks.fetchPrPreflight).toHaveBeenCalledTimes(1);
      expect(mocks.fetchPrOptions).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByDisplayValue("AI title")).toBeInTheDocument();
    const bodyInput = (await screen.findByLabelText(/body/i)) as HTMLTextAreaElement;
    expect(bodyInput).toBeInTheDocument();
    expect(bodyInput.value).toContain("## Summary");
    expect(bodyInput.value).toContain("## Changes");
    expect(bodyInput.value).toContain("## Testing");
    expect(bodyInput.value).toContain("## Linked Task");

    expect(screen.getByText(/pre-flight checks/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/base branch/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/create as draft/i)).toBeInTheDocument();
    expect(screen.getByText("Reviewers")).toBeInTheDocument();
    expect(screen.getByText("Assignees")).toBeInTheDocument();
    expect(screen.getByText("Labels")).toBeInTheDocument();
    expect(screen.getByText(/diff & commit preview/i)).toBeInTheDocument();
    expect(screen.getByText("Commits")).toBeInTheDocument();
    expect(screen.getByText("Changed files")).toBeInTheDocument();
    expect(screen.getByText(/using/i)).toBeInTheDocument();
  });

  it("renders preflight and options before metadata resolves", async () => {
    const metadataDeferred = createDeferred<typeof metadata>();
    mocks.generatePrMetadata.mockReturnValueOnce(metadataDeferred.promise);

    renderModal();

    expect(await screen.findByText("Branch pushed to remote")).toBeInTheDocument();
    expect(screen.getByLabelText(/base branch/i)).toBeEnabled();
    expect(screen.getByText("Reviewers")).toBeInTheDocument();
    expect(screen.getByText(/generating ai title/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create PR" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "Manual PR title" } });
    expect(screen.getByRole("button", { name: "Create PR" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/body/i), { target: { value: "Manual PR body" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Create PR" })).toBeEnabled());

    fireEvent.change(screen.getByPlaceholderText("Filter reviewers"), { target: { value: "rev" } });
    fireEvent.click(screen.getByRole("button", { name: /reviewer 1/i }));
    expect(screen.getByRole("button", { name: /remove reviewer 1/i })).toBeInTheDocument();

    metadataDeferred.resolve(metadata);
    expect(await screen.findByDisplayValue("Manual PR title")).toBeInTheDocument();
  });

  it("keeps submit disabled while preflight is pending or failed", async () => {
    const preflightDeferred = createDeferred<typeof preflight>();
    mocks.fetchPrPreflight.mockReturnValueOnce(preflightDeferred.promise);

    renderModal();

    expect(await screen.findByDisplayValue("AI title")).toBeInTheDocument();
    expect(screen.getByText(/loading pre-flight checks/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create PR" })).toBeDisabled();

    preflightDeferred.reject(new Error("preflight blew up"));
    expect(await screen.findByText("preflight blew up")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create PR" })).toBeDisabled();
  });

  it("keeps metadata failure scoped so the modal remains usable", async () => {
    mocks.generatePrMetadata.mockRejectedValueOnce(new Error("metadata blew up"));
    renderModal();

    expect(await screen.findByText("metadata blew up")).toBeInTheDocument();
    expect(screen.getByText("Branch pushed to remote")).toBeInTheDocument();
    expect(screen.getByLabelText(/base branch/i)).toBeEnabled();

    const bodyInput = screen.getByLabelText(/body/i) as HTMLTextAreaElement;
    expect(bodyInput.value).toContain("## Summary");
    expect(bodyInput.value).toContain("## Changes");
    expect(bodyInput.value).toContain("## Testing");
    expect(bodyInput.value).toContain("Closes FN-4756");

    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "Manual fallback title" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Create PR" })).toBeEnabled());
  });

  it("requires a non-empty body before submitting manual PR metadata", async () => {
    mocks.generatePrMetadata.mockRejectedValueOnce(new Error("metadata blew up"));
    renderModal();

    expect(await screen.findByText("metadata blew up")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "Manual fallback title" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Create PR" })).toBeEnabled());

    fireEvent.change(screen.getByLabelText(/body/i), { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Create PR" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Create PR" }));
    expect(mocks.createPr).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/body/i), { target: { value: "Manual fallback body" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Create PR" })).toBeEnabled());
  });

  it("uses route fallback metadata as editable content after a timeout response", async () => {
    mocks.generatePrMetadata.mockResolvedValueOnce({
      title: "Fallback title",
      body: "## Summary\n\nSummary unavailable.\n\n## Changes\n\n- Details unavailable.\n\n## Testing\n\n- Not provided.\n\n## Linked Task\n\nCloses FN-4756",
      templateUsed: false,
    });
    renderModal();

    expect(await screen.findByDisplayValue("Fallback title")).toBeInTheDocument();
    const bodyInput = screen.getByLabelText(/body/i) as HTMLTextAreaElement;
    expect(bodyInput.value).toContain("## Summary");
    expect(bodyInput.value).toContain("Closes FN-4756");
    expect(screen.queryByText(/generating ai title/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create PR" })).toBeEnabled();
  });

  it("keeps options failure scoped so metadata and preflight still render", async () => {
    mocks.fetchPrOptions.mockRejectedValueOnce(new Error("options blew up"));
    renderModal();

    expect(await screen.findByDisplayValue("AI title")).toBeInTheDocument();
    expect(screen.getByText("Branch pushed to remote")).toBeInTheDocument();
    expect(await screen.findByText("options blew up")).toBeInTheDocument();
    expect(screen.getByLabelText(/base branch/i)).toBeDisabled();
    expect(screen.getByRole("button", { name: "Create PR" })).toBeEnabled();
  });

  it("renders empty option and preview states without throwing", async () => {
    mocks.fetchPrPreflight.mockResolvedValueOnce({ ...preflight, commits: [], changedFiles: [] });
    mocks.fetchPrOptions.mockResolvedValueOnce({ ...options, baseBranches: [], reviewers: [], assignees: [], labels: [] });

    await renderModalLoaded();

    expect(screen.getByText("No commits found.")).toBeInTheDocument();
    expect(screen.getByText("No changed files detected.")).toBeInTheDocument();
    expect(screen.getByLabelText(/base branch/i)).toBeDisabled();
  });

  it("regenerates AI content without re-blocking preflight and options", async () => {
    const regenerateDeferred = createDeferred<typeof metadata>();
    mocks.generatePrMetadata.mockResolvedValueOnce(metadata).mockReturnValueOnce(regenerateDeferred.promise);
    await renderModalLoaded();
    const titleInput = screen.getByDisplayValue("AI title");
    fireEvent.change(titleInput, { target: { value: "custom" } });
    expect(screen.getByRole("button", { name: /revert to ai version/i })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: /^regenerate$/i })[0]);
    expect(screen.getByText("Branch pushed to remote")).toBeInTheDocument();
    expect(screen.getByLabelText(/base branch/i)).toBeEnabled();
    expect(screen.getByText(/generating ai title/i)).toBeInTheDocument();
    regenerateDeferred.resolve({ title: "New title", body: "New body", templateUsed: false });
    await screen.findByDisplayValue("New title");
    fireEvent.change(screen.getByDisplayValue("New title"), { target: { value: "edited" } });
    fireEvent.click(screen.getByRole("button", { name: /revert to ai version/i }));
    expect(screen.getByDisplayValue("New title")).toBeInTheDocument();
  });

  it("disables submit when preflight fails and toggles draft label", async () => {
    mocks.fetchPrPreflight.mockResolvedValueOnce({ ...preflight, ghAuthOk: false });
    renderModal();
    const submitButton = await screen.findByRole("button", { name: "Create PR" });
    expect(submitButton).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/create as draft/i));
    expect(screen.getByRole("button", { name: "Create draft PR" })).toBeInTheDocument();
  });

  it("refreshes preflight independently when the base branch changes", async () => {
    const baseChangeDeferred = createDeferred<typeof preflight>();
    mocks.fetchPrPreflight
      .mockResolvedValueOnce(preflight)
      .mockReturnValueOnce(baseChangeDeferred.promise);

    await renderModalLoaded();

    fireEvent.change(screen.getByLabelText(/base branch/i), { target: { value: "develop" } });
    expect(mocks.fetchPrPreflight).toHaveBeenLastCalledWith("FN-4756", undefined, "develop");
    expect(screen.getByText(/loading pre-flight checks/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue("AI title")).toBeInTheDocument();

    baseChangeDeferred.resolve({ ...preflight, defaultBaseBranch: "develop" });
    await waitFor(() => expect(screen.queryByText(/loading pre-flight checks/i)).not.toBeInTheDocument());
    expect(screen.getByLabelText(/base branch/i)).toHaveValue("develop");
  });

  it("adds and removes chips and submits payload", async () => {
    const { onCreated, addToast, onClose } = await renderModalLoaded();

    fireEvent.change(screen.getByLabelText(/base branch/i), { target: { value: "develop" } });
    fireEvent.click(screen.getByLabelText(/create as draft/i));
    fireEvent.change(screen.getByPlaceholderText("Filter reviewers"), { target: { value: "rev" } });
    fireEvent.click(screen.getByRole("button", { name: /reviewer 1/i }));
    fireEvent.change(screen.getByPlaceholderText("Filter assignees"), { target: { value: "assign" } });
    fireEvent.click(screen.getByRole("button", { name: /assignee 1/i }));
    fireEvent.change(screen.getByPlaceholderText("Filter labels"), { target: { value: "bug" } });
    fireEvent.click(screen.getByRole("button", { name: "bug" }));

    const submitButton = screen.getByRole("button", { name: "Create draft PR" });
    expect(submitButton).toHaveClass("btn-primary");
    await waitFor(() => expect(submitButton).toBeEnabled());
    fireEvent.click(submitButton);

    await waitFor(() => expect(mocks.createPr).toHaveBeenCalledTimes(1));
    expect(mocks.createPr.mock.calls[0][1]).toMatchObject({
      title: "AI title",
      body: metadata.body.trim(),
      base: "develop",
      draft: true,
      reviewers: ["rev1"],
      assignees: ["assign1"],
      labels: ["bug"],
    });
    expect(onCreated).toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledWith("Created PR #12", "success");
    expect(onClose).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /remove reviewer 1/i }));
  });

  it("renders push-branch affordance and enables submit after success", async () => {
    mocks.fetchPrPreflight.mockResolvedValue({ ...preflight, branchOnRemote: false });
    mocks.pushPrBranch.mockResolvedValueOnce({ result: { pushed: true, head: "fusion/fn-4756", message: "Pushed fusion/fn-4756 to origin." }, preflight });
    const { addToast } = await renderModalLoaded();

    expect(screen.getByRole("button", { name: "Create PR" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Push branch to remote" }));

    await waitFor(() => expect(mocks.pushPrBranch).toHaveBeenCalledWith("FN-4756", "main", undefined));
    await waitFor(() => expect(screen.getByRole("button", { name: "Create PR" })).toBeEnabled());
    expect(addToast).toHaveBeenCalledWith("Pushed fusion/fn-4756 to origin.", "success");
  });

  it("surfaces push-branch failures", async () => {
    mocks.fetchPrPreflight.mockResolvedValue({ ...preflight, branchOnRemote: false });
    mocks.pushPrBranch.mockRejectedValueOnce(new Error("unable to push branch"));
    await renderModalLoaded();

    fireEvent.click(screen.getByRole("button", { name: "Push branch to remote" }));

    expect(await screen.findByText("unable to push branch")).toBeInTheDocument();
  });

  it("keeps the push-branch remediation usable on narrow mobile widths", async () => {
    mocks.fetchPrPreflight.mockResolvedValue({ ...preflight, branchOnRemote: false });
    const originalInnerWidth = window.innerWidth;

    await act(async () => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
      window.dispatchEvent(new Event("resize"));
    });

    await renderModalLoaded();

    expect(screen.getByRole("button", { name: "Push branch to remote" })).toBeVisible();

    Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
    window.dispatchEvent(new Event("resize"));
  });

  it("renders AI conflict resolution affordance and enables submit after success", async () => {
    mocks.fetchPrPreflight.mockResolvedValue({ ...preflight, conflictsWithBase: true, branchOnRemote: false });
    mocks.resolvePrConflicts.mockResolvedValueOnce({ result: { resolved: true, pushed: true, conflictedFiles: ["a.ts"], message: "resolved" }, preflight });
    const { addToast } = await renderModalLoaded();

    const submitButton = screen.getByRole("button", { name: "Create PR" });
    expect(submitButton).toBeDisabled();
    const resolveButton = await screen.findByRole("button", { name: "Resolve conflicts with AI" });

    fireEvent.click(resolveButton);

    await waitFor(() => expect(mocks.resolvePrConflicts).toHaveBeenCalledWith("FN-4756", "main", undefined));
    await waitFor(() => expect(screen.getByRole("button", { name: "Create PR" })).toBeEnabled());
    expect(addToast).toHaveBeenCalledWith("Resolved PR conflicts and pushed branch", "success");
  });

  it("surfaces conflict resolution failures", async () => {
    mocks.fetchPrPreflight.mockResolvedValue({ ...preflight, conflictsWithBase: true });
    mocks.resolvePrConflicts.mockRejectedValueOnce(new Error("unable to resolve"));
    await renderModalLoaded();

    fireEvent.click(await screen.findByRole("button", { name: "Resolve conflicts with AI" }));

    expect(await screen.findByText("unable to resolve")).toBeInTheDocument();
  });

  it("shows submit error and retries with same payload", async () => {
    mocks.createPr.mockRejectedValueOnce(new Error("bad")).mockResolvedValueOnce({ number: 22, title: "ok", url: "u", status: "open", headBranch: "h", baseBranch: "main", commentCount: 0 } as PrInfo);
    await renderModalLoaded();
    await waitFor(() => expect(screen.getByRole("button", { name: "Create PR" })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: "Create PR" }));
    await waitFor(() => expect(mocks.createPr).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("bad")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(mocks.createPr).toHaveBeenCalledTimes(2));
    expect(mocks.createPr.mock.calls[0][1]).toEqual(mocks.createPr.mock.calls[1][1]);
  });

  it("renders structured gh auth hint", async () => {
    const err = Object.assign(new Error("auth failed"), {
      details: {
        githubError: {
          code: "not-authenticated",
          message: "GitHub CLI is not authenticated.",
          hint: "Run 'gh auth login' to authenticate with GitHub.",
          action: { kind: "shell", command: "gh auth login" },
          retryable: true,
        },
      },
    });
    mocks.createPr.mockRejectedValueOnce(err);
    await renderModalLoaded();
    await waitFor(() => expect(screen.getByRole("button", { name: "Create PR" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Create PR" }));
    await waitFor(() => expect(mocks.createPr).toHaveBeenCalledTimes(1));
    expect((await screen.findAllByText(/gh auth login/i)).length).toBeGreaterThan(0);
  });

  it("closes on overlay click", async () => {
    const { onClose } = await renderModalLoaded();
    const overlay = document.querySelector(".modal-overlay.open");
    expect(overlay).toBeTruthy();
    fireEvent.click(overlay as Element);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on escape", async () => {
    const { onClose } = await renderModalLoaded();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
