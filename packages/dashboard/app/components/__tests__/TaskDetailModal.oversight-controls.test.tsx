/*
FNXC:PlannerOversight 2026-07-04-17:00:
FN-7517 coverage for the task-detail planner-overseer controls: the quick
oversight-level-change select, the manual nudge/stop/explain buttons, and
their enablement/leftover-shell rules (Surface Enumeration).
*/
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { PlannerOverseerRuntimeSnapshot } from "@fusion/core";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopMove,
  noopOpenDetail,
  mockConfirm,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailModal } from "../TaskDetailModal";

setupTaskDetailModalHooks();

const activeSnapshot: PlannerOverseerRuntimeSnapshot = {
  state: "watching",
  oversightLevel: "autonomous",
  watchedStage: "executor",
  signal: "progressing",
  attemptCount: 1,
  attemptLimit: 3,
  pendingConfirmation: false,
  observedAt: 1_700_000_000_000,
  reason: "Task is actively executing in-progress work",
  lastAction: "inject_guidance",
};

describe("TaskDetailModal oversight controls", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockConfirm.mockResolvedValue(true);
    const api = await import("../../api");
    vi.mocked(api.fetchBoardWorkflows).mockResolvedValue({ flagEnabled: false, defaultWorkflowId: "", workflows: [], taskWorkflowIds: {} });
    vi.mocked(api.fetchWorkflowSettingValues).mockResolvedValue({ stored: {}, effective: {}, defaults: {} });
    vi.mocked(api.nudgeOverseer).mockResolvedValue({ applied: false, reason: "oversight-off" });
    vi.mocked(api.stopOverseer).mockResolvedValue({ applied: true, reason: "stopped" });
    vi.mocked(api.explainOverseer).mockResolvedValue({ snapshot: null });
  });

  it("quick level select reflects a per-task override and writes the override on change", async () => {
    const api = await import("../../api");
    const mockUpdate = vi.mocked(api.updateTask);
    mockUpdate.mockResolvedValueOnce(makeTask({ id: "FN-100", plannerOversightLevel: "steer" }) as any);

    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-100", column: "in-progress", plannerOversightLevel: "observe" })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const select = await screen.findByTestId("detail-oversight-level-select");
    expect((select as HTMLSelectElement).value).toBe("observe");

    fireEvent.change(select, { target: { value: "steer" } });

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith("FN-100", { plannerOversightLevel: "steer" }, undefined);
    });
  });

  it("clearing the override writes a null-clear back to the inherited default", async () => {
    const api = await import("../../api");
    const mockUpdate = vi.mocked(api.updateTask);
    mockUpdate.mockResolvedValueOnce(makeTask({ id: "FN-101" }) as any);

    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-101", column: "in-progress", plannerOversightLevel: "steer" })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const select = await screen.findByTestId("detail-oversight-level-select");
    fireEvent.change(select, { target: { value: "__inherit__" } });

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith("FN-101", { plannerOversightLevel: null }, undefined);
    });
  });

  it("nudge is enabled and calls nudgeOverseer when the overseer is actively watching", async () => {
    const api = await import("../../api");
    vi.mocked(api.nudgeOverseer).mockResolvedValueOnce({ applied: true, reason: "nudged", task: makeTask({ id: "FN-102" }) as any });

    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-102", column: "in-progress", plannerOversightLevel: "autonomous", plannerOverseerState: activeSnapshot })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const nudgeBtn = await screen.findByTestId("detail-overseer-nudge");
    expect(nudgeBtn).not.toBeDisabled();
    fireEvent.click(nudgeBtn);

    await waitFor(() => {
      expect(api.nudgeOverseer).toHaveBeenCalledWith("FN-102", undefined);
    });
  });

  it("nudge is disabled when the overseer has no active observation", async () => {
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-103", column: "todo", plannerOversightLevel: "autonomous" })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const nudgeBtn = await screen.findByTestId("detail-overseer-nudge");
    expect(nudgeBtn).toBeDisabled();
  });

  it("shows a visible group label and an in-DOM disabled-reason helper (not just a hover title) when Nudge is unavailable (FN-7546)", async () => {
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-111", column: "todo", plannerOversightLevel: "autonomous" })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const label = await screen.findByTestId("detail-oversight-controls-label");
    expect(label).toHaveTextContent("Overseer controls");

    const nudgeBtn = await screen.findByTestId("detail-overseer-nudge");
    expect(nudgeBtn).toBeDisabled();

    const reason = await screen.findByTestId("detail-overseer-nudge-disabled-reason");
    expect(reason).toHaveTextContent("Nudge unavailable: overseer is not actively watching this task");
  });

  it("does not show the disabled-reason helper when Nudge is enabled", async () => {
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-112", column: "in-progress", plannerOversightLevel: "autonomous", plannerOverseerState: activeSnapshot })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const nudgeBtn = await screen.findByTestId("detail-overseer-nudge");
    expect(nudgeBtn).not.toBeDisabled();
    expect(screen.queryByTestId("detail-overseer-nudge-disabled-reason")).not.toBeInTheDocument();
  });

  it("nudge is disabled while the task is user-paused", async () => {
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-104", column: "in-progress", plannerOversightLevel: "autonomous", plannerOverseerState: activeSnapshot, userPaused: true })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const nudgeBtn = await screen.findByTestId("detail-overseer-nudge");
    expect(nudgeBtn).toBeDisabled();
  });

  it("nudge is disabled when the task is done", async () => {
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-105", column: "done", plannerOversightLevel: "autonomous", plannerOverseerState: activeSnapshot })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const nudgeBtn = await screen.findByTestId("detail-overseer-nudge");
    expect(nudgeBtn).toBeDisabled();
  });

  it("stop calls stopOverseer after confirmation", async () => {
    const api = await import("../../api");
    vi.mocked(api.stopOverseer).mockResolvedValueOnce({ applied: true, reason: "stopped", task: makeTask({ id: "FN-106", plannerOversightLevel: "off" }) as any });

    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-106", column: "in-progress", plannerOversightLevel: "steer" })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const stopBtn = await screen.findByTestId("detail-overseer-stop");
    fireEvent.click(stopBtn);

    await waitFor(() => {
      expect(mockConfirm).toHaveBeenCalled();
      expect(api.stopOverseer).toHaveBeenCalledWith("FN-106", undefined);
    });
  });

  it("stop is hidden when oversight is already off", async () => {
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-107", column: "in-progress", plannerOversightLevel: "off" })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await screen.findByTestId("detail-oversight-level-select");
    expect(screen.queryByTestId("detail-overseer-stop")).not.toBeInTheDocument();
  });

  it("explain renders watched stage/reason/action/attempt-count from overseer state", async () => {
    const api = await import("../../api");
    vi.mocked(api.explainOverseer).mockResolvedValueOnce({ snapshot: activeSnapshot });

    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-108", column: "in-progress", plannerOversightLevel: "autonomous", plannerOverseerState: activeSnapshot })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const explainBtn = await screen.findByTestId("detail-overseer-explain");
    fireEvent.click(explainBtn);

    const panel = await screen.findByTestId("detail-overseer-explain-panel");
    expect(panel).toHaveTextContent("executor");
    expect(panel).toHaveTextContent("Task is actively executing in-progress work");
    expect(panel).toHaveTextContent("inject_guidance");
    expect(panel).toHaveTextContent("1");
    expect(panel).toHaveTextContent("3");
  });

  it("explain shows the inactive empty-state (no empty shell) when the overseer is inactive", async () => {
    const api = await import("../../api");
    vi.mocked(api.explainOverseer).mockResolvedValueOnce({ snapshot: null });

    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-109", column: "in-progress", plannerOversightLevel: "observe", plannerOverseerState: activeSnapshot })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const explainBtn = await screen.findByTestId("detail-overseer-explain");
    fireEvent.click(explainBtn);

    const panel = await screen.findByTestId("detail-overseer-explain-panel");
    expect(panel).toHaveTextContent("not currently watching");
  });

  it("Explain is never disabled while the overseer is inactive and always opens the read-only panel (FN-7546)", async () => {
    const api = await import("../../api");
    vi.mocked(api.explainOverseer).mockResolvedValueOnce({ snapshot: null });

    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-113", column: "todo", plannerOversightLevel: "autonomous" })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const explainBtn = await screen.findByTestId("detail-overseer-explain");
    // Read-only Explain must never be disabled purely because the overseer
    // isn't actively watching — that inactive state is exactly what the
    // panel's empty-state message communicates.
    expect(explainBtn).not.toBeDisabled();

    fireEvent.click(explainBtn);

    const panel = await screen.findByTestId("detail-overseer-explain-panel");
    expect(panel).toHaveTextContent("not currently watching");
  });

  it("renders no oversight-control leftover shell when oversight is off and the overseer is inactive (default case)", async () => {
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-110", column: "todo", plannerOversightLevel: "off" })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    // The quick level-change select still renders (it's always editable so an
    // operator can opt IN to oversight), but nudge/stop/explain must not
    // render an always-on empty shell for the common off+inactive default.
    await screen.findByTestId("detail-oversight-level-select");
    expect(screen.queryByTestId("detail-overseer-nudge")).not.toBeInTheDocument();
    expect(screen.queryByTestId("detail-overseer-stop")).not.toBeInTheDocument();
    expect(screen.queryByTestId("detail-overseer-explain")).not.toBeInTheDocument();
  });
});

/*
 * FNXC:PlannerOversight 2026-07-04-19:45:
 * FN-7521 Surface Enumeration requirement: cover the oversight quick-controls
 * cluster (`.detail-meta-inline-controls`) at both desktop AND mobile
 * (@media max-width: 768px) breakpoints. TaskDetailModal.tsx has no JS-side
 * isMobile/matchMedia branch for this cluster — TaskDetailModal.css only
 * wraps `.detail-meta-inline-controls` via a `@media (max-width: 768px)` CSS
 * rule (flex-wrap, no conditional DOM). This suite proves the same controls
 * are present (no leftover/missing shell) at a narrow `window.innerWidth`,
 * guarding against a future mobile-only regression (FN-6115→FN-6123
 * precedent in AGENTS.md: an affordance removal left an empty control shell
 * on mobile only, because only the desktop surface was checked).
 */
describe("TaskDetailModal oversight controls — mobile breakpoint (FN-7521, @media max-width: 768px)", () => {
  const originalInnerWidth = window.innerWidth;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockConfirm.mockResolvedValue(true);
    const api = await import("../../api");
    vi.mocked(api.fetchBoardWorkflows).mockResolvedValue({ flagEnabled: false, defaultWorkflowId: "", workflows: [], taskWorkflowIds: {} });
    vi.mocked(api.fetchWorkflowSettingValues).mockResolvedValue({ stored: {}, effective: {}, defaults: {} });
    vi.mocked(api.nudgeOverseer).mockResolvedValue({ applied: false, reason: "oversight-off" });
    vi.mocked(api.stopOverseer).mockResolvedValue({ applied: true, reason: "stopped" });
    vi.mocked(api.explainOverseer).mockResolvedValue({ snapshot: null });
    Object.defineProperty(window, "innerWidth", { value: 375, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { value: originalInnerWidth, configurable: true });
  });

  it("still renders the quick level-change select at a 375px mobile viewport and writes on change", async () => {
    const api = await import("../../api");
    const mockUpdate = vi.fn().mockResolvedValue(makeTask({ id: "FN-201", plannerOversightLevel: "steer" }));
    vi.mocked(api.updateTask).mockImplementation(mockUpdate as any);

    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-201", column: "todo", plannerOversightLevel: "observe" })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const select = await screen.findByTestId("detail-oversight-level-select");
    expect(select).toBeTruthy();
    fireEvent.change(select, { target: { value: "steer" } });

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith("FN-201", { plannerOversightLevel: "steer" }, undefined);
    });
  });

  it("still renders enabled nudge/stop/explain controls at a 375px mobile viewport when the overseer is actively watching", async () => {
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-202", column: "in-progress", plannerOversightLevel: "autonomous", plannerOverseerState: activeSnapshot })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expect(await screen.findByTestId("detail-overseer-nudge")).not.toBeDisabled();
    expect(await screen.findByTestId("detail-overseer-stop")).toBeTruthy();
    expect(await screen.findByTestId("detail-overseer-explain")).toBeTruthy();
  });

  it("still renders no oversight-control leftover shell at a 375px mobile viewport for the off+inactive default case", async () => {
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-203", column: "todo", plannerOversightLevel: "off" })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await screen.findByTestId("detail-oversight-level-select");
    expect(screen.queryByTestId("detail-overseer-nudge")).not.toBeInTheDocument();
    expect(screen.queryByTestId("detail-overseer-stop")).not.toBeInTheDocument();
    expect(screen.queryByTestId("detail-overseer-explain")).not.toBeInTheDocument();
  });
});
