import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PullRequestView, type PrDetail } from "../components/PullRequestView";

// Icons → simple stubs so assertions key on text/testids, not SVG internals.
vi.mock("lucide-react", () => {
  const Stub = () => <span />;
  return {
    AlertTriangle: Stub,
    CheckCircle: Stub,
    Clock: Stub,
    ExternalLink: Stub,
    GitMerge: Stub,
    GitPullRequest: Stub,
    MessageSquare: Stub,
    RotateCcw: Stub,
    ThumbsUp: Stub,
    XCircle: Stub,
  };
});

function makeSummary(over: Partial<PrDetail["summary"]> = {}): PrDetail["summary"] {
  return {
    mergeable: "clean",
    reviewDecision: "APPROVED",
    checksRollup: "success",
    conflicting: false,
    autoMerge: false,
    autoMergeReason: "Ready to merge",
    autoMergeReady: true,
    actionable: true,
    active: true,
    pendingThreads: 0,
    disagreedThreads: 0,
    ...over,
  };
}

function makeDetail(over: Partial<PrDetail> = {}): PrDetail {
  return {
    id: "PR-1",
    sourceType: "task",
    sourceId: "FN-1",
    repo: "owner/repo",
    headBranch: "feature/x",
    state: "open",
    prNumber: 42,
    prUrl: "https://example/pr/42",
    mergeable: "clean",
    checksRollup: "success",
    reviewDecision: "APPROVED",
    autoMerge: false,
    unverified: false,
    responseRounds: 0,
    threads: [],
    summary: makeSummary(over.summary),
    ...over,
  };
}

describe("PullRequestView per-node-state rendering", () => {
  it("creating → 'Creating PR…' placeholder", () => {
    render(<PullRequestView detail={makeDetail({ state: "creating" })} />);
    expect(screen.getByTestId("pr-view").dataset.state).toBe("creating");
    expect(screen.getByTestId("pr-creating").textContent).toContain("Creating PR");
  });

  it("failed → failure reason + Retry PR creation action", async () => {
    const onAction = vi.fn(async () => makeDetail({ state: "creating" }));
    render(
      <PullRequestView
        detail={makeDetail({ state: "failed", failureReason: "gh auth missing" })}
        onAction={onAction}
      />,
    );
    expect(screen.getByTestId("pr-failed").textContent).toContain("gh auth missing");
    fireEvent.click(screen.getByTestId("pr-retry-create"));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith("retry-create", "PR-1", undefined));
  });

  it("unverified → 'Verifying with GitHub…', checks/threads hidden, merge disabled", () => {
    render(
      <PullRequestView
        detail={makeDetail({ unverified: true, threads: [
          { prEntityId: "PR-1", threadId: "T1", headOid: "a", outcome: "pending", updatedAt: 0 },
        ] })}
      />,
    );
    expect(screen.getByTestId("pr-unverified").textContent).toContain("Verifying with GitHub");
    expect(screen.queryByTestId("pr-threads")).toBeNull();
    expect(screen.queryByTestId("pr-summary")).toBeNull();
    expect((screen.getByTestId("pr-merge") as HTMLButtonElement).disabled).toBe(true);
  });

  it("responding → banner with N pending threads, respond/retry disabled, per-thread pending markers", () => {
    render(
      <PullRequestView
        detail={makeDetail({
          state: "responding",
          summary: makeSummary({ pendingThreads: 3 }),
          threads: [
            { prEntityId: "PR-1", threadId: "T1", headOid: "a", outcome: "pending", updatedAt: 0 },
          ],
        })}
      />,
    );
    expect(screen.getByTestId("pr-responding").textContent).toContain("3 threads pending");
    expect((screen.getByTestId("pr-retry") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("pr-thread-pending")).toBeTruthy();
  });

  it("open/await-review → action bar (Approve/Retry/Merge/Close) + auto-merge gate reason", () => {
    render(<PullRequestView detail={makeDetail({ summary: makeSummary({ autoMergeReason: "Waiting for approval" }) })} />);
    expect(screen.getByTestId("pr-action-bar")).toBeTruthy();
    expect(screen.getByTestId("pr-approve")).toBeTruthy();
    expect(screen.getByTestId("pr-retry")).toBeTruthy();
    expect(screen.getByTestId("pr-merge")).toBeTruthy();
    expect(screen.getByTestId("pr-close")).toBeTruthy();
    expect(screen.getByTestId("pr-automerge-gate").textContent).toBe("Waiting for approval");
  });

  it("conflict → Merge disabled + 'Resolve conflicts on GitHub' link", () => {
    render(
      <PullRequestView
        detail={makeDetail({
          mergeable: "conflicting",
          summary: makeSummary({ conflicting: true, autoMergeReason: "Blocked: conflict" }),
        })}
      />,
    );
    expect((screen.getByTestId("pr-merge") as HTMLButtonElement).disabled).toBe(true);
    const link = screen.getByTestId("pr-conflict-link") as HTMLAnchorElement;
    expect(link.textContent).toContain("Resolve conflicts on GitHub");
    expect(link.href).toContain("/pr/42");
  });

  it("agent disagreements are visually distinguished from human-awaiting threads", () => {
    render(
      <PullRequestView
        detail={makeDetail({
          threads: [
            { prEntityId: "PR-1", threadId: "T1", headOid: "a", outcome: "disagreed", updatedAt: 0 },
            { prEntityId: "PR-1", threadId: "T2", headOid: "a", outcome: "pending", updatedAt: 0 },
          ],
        })}
      />,
    );
    const disagreed = screen.getByTestId("pr-thread-disagreed");
    expect(disagreed.dataset.agentDisagreement).toBe("true");
    expect(disagreed.className).toContain("pr-thread--agent-disagreement");
    const pending = screen.getByTestId("pr-thread-pending");
    expect(pending.dataset.agentDisagreement).toBe("false");
  });

  it("merge uses a single confirm step, then fires the merge action", async () => {
    const onAction = vi.fn(async () => makeDetail());
    render(<PullRequestView detail={makeDetail()} onAction={onAction} />);
    fireEvent.click(screen.getByTestId("pr-merge"));
    // Single-confirm: a confirm control appears (no heavy modal).
    const confirm = await screen.findByTestId("pr-merge-confirm");
    fireEvent.click(confirm);
    await waitFor(() => expect(onAction).toHaveBeenCalledWith("merge", "PR-1", undefined));
  });

  it("auto-merge toggle dispatches the automerge action with enabled flag", async () => {
    const onAction = vi.fn(async () => makeDetail({ autoMerge: true }));
    render(<PullRequestView detail={makeDetail({ autoMerge: false })} onAction={onAction} />);
    fireEvent.click(screen.getByTestId("pr-automerge").querySelector("input")!);
    await waitFor(() => expect(onAction).toHaveBeenCalledWith("automerge", "PR-1", { enabled: true }));
  });
});
