import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlanningModeModal } from "../PlanningModeModal";
import { NavigationHistoryProvider, useNavigationHistory } from "../../hooks/useNavigationHistory";

const mockViewportMode = vi.fn<() => "mobile" | "desktop">();
const mockFetchAiSessions = vi.fn();
const mockFetchAiSession = vi.fn();
const mockFetchModels = vi.fn();
const mockSubscribeSse = vi.fn(() => vi.fn());

vi.mock("../../hooks/useViewportMode", () => ({
  useViewportMode: () => mockViewportMode(),
}));

vi.mock("../../hooks/useSessionLock", () => ({
  useSessionLock: () => ({
    isLockedByOther: false,
    takeControl: vi.fn(),
    isLoading: false,
  }),
}));

vi.mock("../../hooks/useAiSessionSync", () => ({
  useAiSessionSync: () => ({
    activeTabMap: new Map(),
    broadcastUpdate: vi.fn(),
    broadcastCompleted: vi.fn(),
    broadcastLock: vi.fn(),
    broadcastUnlock: vi.fn(),
    broadcastHeartbeat: vi.fn(),
  }),
}));

vi.mock("../../utils/getSessionTabId", () => ({
  getSessionTabId: () => "tab-1",
}));

vi.mock("../../sse-bus", () => ({
  subscribeSse: (...args: unknown[]) => mockSubscribeSse(...args),
}));

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    fetchAiSessions: (...args: unknown[]) => mockFetchAiSessions(...args),
    fetchAiSession: (...args: unknown[]) => mockFetchAiSession(...args),
    fetchModels: (...args: unknown[]) => mockFetchModels(...args),
    parseConversationHistory: () => [],
    updateGlobalSettings: vi.fn().mockResolvedValue(undefined),
  };
});

const planningSessionSummary = {
  id: "plan-1",
  type: "planning" as const,
  title: "Roadmap draft",
  preview: "Plan authentication",
  status: "draft" as const,
  archived: false,
  createdAt: "2026-05-01T00:00:00.000Z",
  updatedAt: "2026-05-01T00:00:00.000Z",
  projectId: null,
};

const planningSessionDetail = {
  ...planningSessionSummary,
  inputPayload: JSON.stringify({ initialPlan: "Plan authentication" }),
  conversationHistory: "[]",
  thinkingOutput: "",
  currentQuestion: null,
  result: null,
  error: null,
};

function HistoryHarness({ children }: { children: ReactNode }) {
  const history = useNavigationHistory({ enabled: true });
  return <NavigationHistoryProvider value={history}>{children}</NavigationHistoryProvider>;
}

const countNavIndexPushes = (pushStateSpy: ReturnType<typeof vi.spyOn>) =>
  pushStateSpy.mock.calls.filter(([state]) => typeof (state as { navIndex?: unknown })?.navIndex === "number").length;

describe("PlanningModeModal mobile swipe-back", () => {
  let pushStateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockViewportMode.mockReturnValue("mobile");
    mockFetchAiSessions.mockResolvedValue([planningSessionSummary]);
    mockFetchAiSession.mockResolvedValue(planningSessionDetail);
    mockFetchModels.mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] });
    pushStateSpy = vi.spyOn(window.history, "pushState");
  });

  it("pushes one mobile nav entry when opening a planning session and popstate returns to list view", async () => {
    const { rerender } = render(
      <HistoryHarness>
        <PlanningModeModal isOpen={true} onClose={vi.fn()} onTaskCreated={vi.fn()} onTasksCreated={vi.fn()} tasks={[]} />
      </HistoryHarness>,
    );

    await waitFor(() => {
      expect(screen.getByText("Roadmap draft")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Roadmap draft"));

    await waitFor(() => {
      expect(mockFetchAiSession).toHaveBeenCalledWith("plan-1");
      expect(countNavIndexPushes(pushStateSpy)).toBe(1);
    });

    rerender(
      <HistoryHarness>
        <PlanningModeModal isOpen={true} onClose={vi.fn()} onTaskCreated={vi.fn()} onTasksCreated={vi.fn()} tasks={[]} />
      </HistoryHarness>,
    );

    await waitFor(() => {
      expect(countNavIndexPushes(pushStateSpy)).toBe(1);
    });

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: { navIndex: 0 } }));
    });

    await waitFor(() => {
      const body = document.querySelector(".planning-modal-body");
      expect(body).toHaveClass("planning-modal-body--show-list");
      expect(body).not.toHaveClass("planning-modal-body--show-detail");
    });
  });

  it("pushes a mobile nav entry when opening New Session and popstate returns to the list", async () => {
    render(
      <HistoryHarness>
        <PlanningModeModal isOpen={true} onClose={vi.fn()} onTaskCreated={vi.fn()} onTasksCreated={vi.fn()} tasks={[]} />
      </HistoryHarness>,
    );

    await waitFor(() => {
      expect(screen.getByText("Roadmap draft")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /new session/i }));

    await waitFor(() => {
      expect(pushStateSpy).toHaveBeenCalledWith(expect.objectContaining({ navIndex: expect.any(Number) }), "");
    });

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: { navIndex: 0 } }));
    });

    await waitFor(() => {
      const body = document.querySelector(".planning-modal-body");
      expect(body).toHaveClass("planning-modal-body--show-list");
      expect(body).not.toHaveClass("planning-modal-body--show-detail");
    });
  });

  it("does not push nav entries on desktop for either selecting a session or opening New Session", async () => {
    mockViewportMode.mockReturnValue("desktop");

    render(
      <HistoryHarness>
        <PlanningModeModal isOpen={true} onClose={vi.fn()} onTaskCreated={vi.fn()} onTasksCreated={vi.fn()} tasks={[]} />
      </HistoryHarness>,
    );

    await waitFor(() => {
      expect(screen.getByText("Roadmap draft")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Roadmap draft"));
    fireEvent.click(screen.getByRole("button", { name: /new session/i }));

    await waitFor(() => {
      expect(mockFetchAiSession).toHaveBeenCalledWith("plan-1");
    });

    expect(countNavIndexPushes(pushStateSpy)).toBe(0);
  });

  it("re-arms mobile push after closing and reopening the modal", async () => {
    const { rerender } = render(
      <HistoryHarness>
        <PlanningModeModal isOpen={true} onClose={vi.fn()} onTaskCreated={vi.fn()} onTasksCreated={vi.fn()} tasks={[]} />
      </HistoryHarness>,
    );

    await waitFor(() => {
      expect(screen.getByText("Roadmap draft")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /new session/i }));
    await waitFor(() => {
      expect(countNavIndexPushes(pushStateSpy)).toBe(1);
    });

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: { navIndex: 0 } }));
    });

    await waitFor(() => {
      const body = document.querySelector(".planning-modal-body");
      expect(body).toHaveClass("planning-modal-body--show-list");
      expect(body).not.toHaveClass("planning-modal-body--show-detail");
    });

    rerender(
      <HistoryHarness>
        <PlanningModeModal isOpen={false} onClose={vi.fn()} onTaskCreated={vi.fn()} onTasksCreated={vi.fn()} tasks={[]} />
      </HistoryHarness>,
    );

    rerender(
      <HistoryHarness>
        <PlanningModeModal isOpen={true} onClose={vi.fn()} onTaskCreated={vi.fn()} onTasksCreated={vi.fn()} tasks={[]} />
      </HistoryHarness>,
    );

    await waitFor(() => {
      expect(screen.getByText("Roadmap draft")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /new session/i }));

    await waitFor(() => {
      expect(countNavIndexPushes(pushStateSpy)).toBe(2);
    });
  });
});
