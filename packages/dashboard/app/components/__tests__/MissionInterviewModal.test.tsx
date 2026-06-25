import type React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MissionInterviewModal } from "../MissionInterviewModal";

const mockStartMissionInterview = vi.fn();
const mockRespondToMissionInterview = vi.fn();
const mockRetryMissionInterviewSession = vi.fn();
const mockCancelMissionInterview = vi.fn();
const mockCreateMissionFromInterview = vi.fn();
const mockConnectMissionInterviewStream = vi.fn();
const mockFetchAiSession = vi.fn();
const mockParseConversationHistory = vi.fn();
const mockAcquireSessionLock = vi.fn();
const mockReleaseSessionLock = vi.fn();
const mockForceAcquireSessionLock = vi.fn();
const mockFetchModels = vi.fn();

vi.mock("../../api", () => ({
  startMissionInterview: (...args: any[]) => mockStartMissionInterview(...args),
  respondToMissionInterview: (...args: any[]) => mockRespondToMissionInterview(...args),
  retryMissionInterviewSession: (...args: any[]) => mockRetryMissionInterviewSession(...args),
  cancelMissionInterview: (...args: any[]) => mockCancelMissionInterview(...args),
  createMissionFromInterview: (...args: any[]) => mockCreateMissionFromInterview(...args),
  connectMissionInterviewStream: (...args: any[]) => mockConnectMissionInterviewStream(...args),
  fetchAiSession: (...args: any[]) => mockFetchAiSession(...args),
  parseConversationHistory: (...args: any[]) => mockParseConversationHistory(...args),
  acquireSessionLock: (...args: any[]) => mockAcquireSessionLock(...args),
  releaseSessionLock: (...args: any[]) => mockReleaseSessionLock(...args),
  forceAcquireSessionLock: (...args: any[]) => mockForceAcquireSessionLock(...args),
  fetchModels: (...args: any[]) => mockFetchModels(...args),
}));

const mockGetMissionGoal = vi.fn(() => "");
const mockSaveMissionGoal = vi.fn();

vi.mock("../../hooks/modalPersistence", () => ({
  saveMissionGoal: (...args: any[]) => mockSaveMissionGoal(...args),
  getMissionGoal: (...args: any[]) => mockGetMissionGoal(...args),
  clearMissionGoal: vi.fn(),
}));

const SAMPLE_QUESTION = {
  id: "scope",
  type: "single_select" as const,
  question: "What is the target scope?",
  description: "Pick the size for this mission.",
  options: [
    { id: "mvp", label: "MVP" },
    { id: "full", label: "Full" },
  ],
};

const SECOND_QUESTION = {
  id: "platform",
  type: "text" as const,
  question: "Which platforms should this mission cover?",
  description: "List the product surfaces that need support.",
};

const SAMPLE_SUMMARY = {
  missionTitle: "Resilient mission planning",
  missionDescription: "Recover mission AI planning after transient stream interruptions.",
  milestones: [
    {
      title: "Recovery milestone",
      description: "Keep the interview usable after reconnecting.",
      slices: [
        {
          title: "Stream recovery",
          description: "Reconnect recoverable mission interviews.",
          features: [
            {
              title: "Continue interview",
              description: "The modal resumes from the next streamed state.",
            },
          ],
        },
      ],
    },
  ],
};

function buildMissionSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "mission-session-1",
    type: "mission_interview",
    status: "generating",
    title: "Build a mission planning workflow",
    inputPayload: JSON.stringify({ goal: "Build a mission planning workflow" }),
    conversationHistory: "[]",
    currentQuestion: null,
    result: null,
    thinkingOutput: "Continuing...",
    error: null,
    projectId: null,
    lockedByTab: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lockedAt: null,
    ...overrides,
  };
}

describe("MissionInterviewModal", () => {
  let streamHandlers: any;

  beforeEach(() => {
    vi.clearAllMocks();
    streamHandlers = undefined;

    mockStartMissionInterview.mockResolvedValue({ sessionId: "mission-session-1" });
    mockRetryMissionInterviewSession.mockResolvedValue({ success: true, sessionId: "mission-session-1" });
    mockFetchAiSession.mockResolvedValue(null);
    mockSaveMissionGoal.mockReset();
    mockParseConversationHistory.mockImplementation((raw: string) => {
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    });
    mockConnectMissionInterviewStream.mockImplementation((_sessionId, _projectId, handlers) => {
      streamHandlers = handlers;
      return {
        close: vi.fn(),
        isConnected: vi.fn().mockReturnValue(true),
      };
    });
    mockAcquireSessionLock.mockResolvedValue({ acquired: true, currentHolder: null });
    mockReleaseSessionLock.mockResolvedValue(undefined);
    mockForceAcquireSessionLock.mockResolvedValue({ acquired: true, currentHolder: null });
    mockFetchModels.mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] });
  });

  function renderModal(props: Partial<React.ComponentProps<typeof MissionInterviewModal>> = {}) {
    const onClose = props.onClose ?? vi.fn();

    return {
      onClose,
      ...render(
        <MissionInterviewModal
          isOpen={true}
          onClose={onClose}
          onMissionCreated={vi.fn()}
          {...props}
        />,
      ),
    };
  }

  it("shows lock overlay and allows take-control", async () => {
    window.sessionStorage.setItem("fusion-tab-id", "tab-self");
    mockAcquireSessionLock.mockResolvedValueOnce({ acquired: false, currentHolder: "tab-other" });

    renderModal();

    fireEvent.change(screen.getByLabelText("What do you want to build?"), {
      target: { value: "Build a mission planning workflow" },
    });
    fireEvent.click(screen.getByText("Start Interview"));

    await waitFor(() => {
      expect(screen.getByTestId("session-lock-overlay")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Take Control"));

    await waitFor(() => {
      expect(mockForceAcquireSessionLock).toHaveBeenCalledWith("mission-session-1", "tab-self");
    });

    await waitFor(() => {
      expect(screen.queryByTestId("session-lock-overlay")).not.toBeInTheDocument();
    });
  });

  it("shows reconnecting indicator without clearing current question", async () => {
    renderModal();

    fireEvent.change(screen.getByLabelText("What do you want to build?"), {
      target: { value: "Build a mission planning workflow" },
    });
    fireEvent.click(screen.getByText("Start Interview"));

    await waitFor(() => {
      expect(mockStartMissionInterview).toHaveBeenCalledWith("Build a mission planning workflow", undefined, undefined);
      expect(streamHandlers).toBeDefined();
    });

    act(() => {
      streamHandlers.onQuestion?.(SAMPLE_QUESTION);
    });

    expect(await screen.findByText("What is the target scope?")).toBeInTheDocument();

    act(() => {
      streamHandlers.onConnectionStateChange?.("reconnecting");
    });

    expect(screen.getByText("Reconnecting…")).toBeInTheDocument();
    expect(screen.getByText("What is the target scope?")).toBeInTheDocument();

    act(() => {
      streamHandlers.onConnectionStateChange?.("connected");
    });

    await waitFor(() => {
      expect(screen.queryByText("Reconnecting…")).not.toBeInTheDocument();
    });
    expect(screen.getByText("What is the target scope?")).toBeInTheDocument();
  });

  it("preserves streaming thinking output while reconnecting", async () => {
    renderModal();

    fireEvent.change(screen.getByLabelText("What do you want to build?"), {
      target: { value: "Build a mission planning workflow" },
    });
    fireEvent.click(screen.getByText("Start Interview"));

    await waitFor(() => {
      expect(streamHandlers).toBeDefined();
    });

    act(() => {
      streamHandlers.onThinking?.("Analyzing mission goals...");
    });

    expect(await screen.findByText("Analyzing mission goals...")).toBeInTheDocument();

    act(() => {
      streamHandlers.onConnectionStateChange?.("reconnecting");
    });

    expect(screen.getByText("Reconnecting…")).toBeInTheDocument();
    expect(screen.getByText("Analyzing mission goals...")).toBeInTheDocument();
  });

  it("recovers a generating mission interview after a transient Stream error", async () => {
    mockFetchAiSession.mockResolvedValueOnce(buildMissionSession({ status: "generating" }));

    renderModal();

    fireEvent.change(screen.getByLabelText("What do you want to build?"), {
      target: { value: "Build a mission planning workflow" },
    });
    fireEvent.click(screen.getByText("Start Interview"));

    await waitFor(() => {
      expect(streamHandlers).toBeDefined();
    });

    await act(async () => {
      streamHandlers.onError?.("Stream error");
    });

    expect(await screen.findByText("Reconnecting…")).toBeInTheDocument();
    expect(screen.queryByText("Stream error")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();

    await waitFor(() => {
      expect(mockFetchAiSession).toHaveBeenCalledWith("mission-session-1");
      expect(mockConnectMissionInterviewStream).toHaveBeenCalledTimes(2);
    });

    act(() => {
      streamHandlers.onQuestion?.(SECOND_QUESTION);
    });

    expect(await screen.findByText("Which platforms should this mission cover?")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText("Reconnecting…")).not.toBeInTheDocument();
    });
    expect(screen.queryByText("Stream error")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("preserves an awaiting-input question while recovering a transient Stream error", async () => {
    mockFetchAiSession.mockResolvedValueOnce(
      buildMissionSession({
        status: "awaiting_input",
        currentQuestion: JSON.stringify(SAMPLE_QUESTION),
        thinkingOutput: "",
      }),
    );

    renderModal();

    fireEvent.change(screen.getByLabelText("What do you want to build?"), {
      target: { value: "Build a mission planning workflow" },
    });
    fireEvent.click(screen.getByText("Start Interview"));

    await waitFor(() => {
      expect(streamHandlers).toBeDefined();
    });

    act(() => {
      streamHandlers.onQuestion?.(SAMPLE_QUESTION);
    });

    expect(await screen.findByText("What is the target scope?")).toBeInTheDocument();

    await act(async () => {
      streamHandlers.onError?.("Stream error");
    });

    expect(await screen.findByText("Reconnecting…")).toBeInTheDocument();
    expect(screen.getByText("What is the target scope?")).toBeInTheDocument();
    expect(screen.queryByText("Stream error")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();

    await waitFor(() => {
      expect(mockFetchAiSession).toHaveBeenCalledWith("mission-session-1");
      expect(mockConnectMissionInterviewStream).toHaveBeenCalledTimes(2);
    });

    act(() => {
      streamHandlers.onSummary?.(SAMPLE_SUMMARY);
    });

    expect(await screen.findByDisplayValue("Resilient mission planning")).toBeInTheDocument();
    expect(screen.queryByText("Reconnecting…")).not.toBeInTheDocument();
    expect(screen.queryByText("Stream error")).not.toBeInTheDocument();
  });

  it("renders a completed mission summary instead of Stream error after recovery finds completion", async () => {
    mockFetchAiSession.mockResolvedValueOnce(
      buildMissionSession({
        status: "complete",
        result: JSON.stringify(SAMPLE_SUMMARY),
        thinkingOutput: "",
      }),
    );

    renderModal();

    fireEvent.change(screen.getByLabelText("What do you want to build?"), {
      target: { value: "Build a mission planning workflow" },
    });
    fireEvent.click(screen.getByText("Start Interview"));

    await waitFor(() => {
      expect(streamHandlers).toBeDefined();
    });

    await act(async () => {
      streamHandlers.onError?.("Stream error");
    });

    expect(await screen.findByDisplayValue("Resilient mission planning")).toBeInTheDocument();
    expect(screen.queryByText("Stream error")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("shows error panel with retry action when stream recovery cannot refresh the session", async () => {
    mockFetchAiSession.mockRejectedValueOnce(new Error("refresh failed"));

    renderModal();

    fireEvent.change(screen.getByLabelText("What do you want to build?"), {
      target: { value: "Build a mission planning workflow" },
    });
    fireEvent.click(screen.getByText("Start Interview"));

    await waitFor(() => {
      expect(streamHandlers).toBeDefined();
    });

    await act(async () => {
      streamHandlers.onError?.("Temporary outage");
    });

    expect(await screen.findByText("Temporary outage")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("shows persisted mission interview errors after stream recovery refreshes the session", async () => {
    mockFetchAiSession.mockResolvedValueOnce(
      buildMissionSession({
        status: "error",
        error: "The mission interview failed permanently.",
        thinkingOutput: "",
      }),
    );

    renderModal();

    fireEvent.change(screen.getByLabelText("What do you want to build?"), {
      target: { value: "Build a mission planning workflow" },
    });
    fireEvent.click(screen.getByText("Start Interview"));

    await waitFor(() => {
      expect(streamHandlers).toBeDefined();
    });

    await act(async () => {
      streamHandlers.onError?.("Stream error");
    });

    expect(await screen.findByText("The mission interview failed permanently.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("retries interview session from error view", async () => {
    let attempt = 0;
    mockConnectMissionInterviewStream.mockImplementation((_sessionId, _projectId, handlers) => {
      streamHandlers = handlers;
      attempt += 1;
      if (attempt === 1) {
        setTimeout(() => handlers.onError?.("Try again"), 10);
      } else {
        setTimeout(() => handlers.onQuestion?.(SAMPLE_QUESTION), 10);
      }
      return {
        close: vi.fn(),
        isConnected: vi.fn().mockReturnValue(true),
      };
    });

    renderModal();

    fireEvent.change(screen.getByLabelText("What do you want to build?"), {
      target: { value: "Build a mission planning workflow" },
    });
    fireEvent.click(screen.getByText("Start Interview"));

    await waitFor(() => {
      expect(screen.getByText("Try again")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(mockRetryMissionInterviewSession).toHaveBeenCalledWith("mission-session-1", undefined, expect.any(String));
    });
    await waitFor(() => {
      expect(screen.getByText("What is the target scope?")).toBeInTheDocument();
    });
    expect(mockConnectMissionInterviewStream).toHaveBeenCalledTimes(2);
  });

  it("recovers connection-loss directly when interview session is still generating", async () => {
    let attempt = 0;
    mockConnectMissionInterviewStream.mockImplementation((_sessionId, _projectId, handlers) => {
      streamHandlers = handlers;
      attempt += 1;
      if (attempt === 1) {
        setTimeout(() => handlers.onError?.("Connection lost"), 10);
      }
      return {
        close: vi.fn(),
        isConnected: vi.fn().mockReturnValue(true),
      };
    });

    mockFetchAiSession.mockResolvedValueOnce(buildMissionSession({ status: "generating" }));

    renderModal();

    fireEvent.change(screen.getByLabelText("What do you want to build?"), {
      target: { value: "Build a mission planning workflow" },
    });
    fireEvent.click(screen.getByText("Start Interview"));

    await waitFor(() => {
      expect(mockFetchAiSession).toHaveBeenCalledWith("mission-session-1");
      expect(mockConnectMissionInterviewStream).toHaveBeenCalledTimes(2);
    });

    expect(await screen.findByText("AI is thinking...")).toBeInTheDocument();
    expect(screen.getByText("Continuing...")).toBeInTheDocument();
    expect(screen.queryByText("Connection lost")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(mockRetryMissionInterviewSession).not.toHaveBeenCalled();
  });

  it("shows comment textarea and submits _comment for non-text questions", async () => {
    renderModal();

    fireEvent.change(screen.getByLabelText("What do you want to build?"), {
      target: { value: "Build a mission planning workflow" },
    });
    fireEvent.click(screen.getByText("Start Interview"));

    await waitFor(() => {
      expect(streamHandlers).toBeDefined();
    });

    act(() => {
      streamHandlers.onQuestion?.(SAMPLE_QUESTION);
    });

    fireEvent.click(await screen.findByText("MVP"));
    fireEvent.change(screen.getByPlaceholderText("Add any extra context or direction..."), {
      target: { value: "Optimize for launch speed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(mockRespondToMissionInterview).toHaveBeenCalledWith(
        "mission-session-1",
        expect.objectContaining({ scope: "mvp", _comment: "Optimize for launch speed" }),
        undefined,
        expect.any(String),
      );
    });
  });

  it("restores persisted goal from localStorage on open", () => {
    mockGetMissionGoal.mockReturnValue("Previous mission goal");

    renderModal();

    const textarea = screen.getByLabelText("What do you want to build?");
    expect(textarea).toHaveValue("Previous mission goal");
  });

  it("closes without cancelling an in-progress interview and renders only one close button", async () => {
    const { onClose } = renderModal();

    fireEvent.change(screen.getByLabelText("What do you want to build?"), {
      target: { value: "Build a mission planning workflow" },
    });
    fireEvent.click(screen.getByText("Start Interview"));

    await waitFor(() => {
      expect(streamHandlers).toBeDefined();
    });

    act(() => {
      streamHandlers.onQuestion?.(SAMPLE_QUESTION);
    });

    const closeButtons = screen.getAllByRole("button", { name: "Close" });
    expect(closeButtons).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Send to background" })).not.toBeInTheDocument();

    fireEvent.click(closeButtons[0]);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockCancelMissionInterview).not.toHaveBeenCalled();
  });

  it("persists the draft goal and closes from the initial view", () => {
    const { onClose } = renderModal({ projectId: "proj-1" });

    fireEvent.change(screen.getByLabelText("What do you want to build?"), {
      target: { value: "Draft mission goal" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(mockSaveMissionGoal).toHaveBeenCalledWith("Draft mission goal", "proj-1");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockCancelMissionInterview).not.toHaveBeenCalled();
  });

  it("closes without cancelling when pressing Escape", async () => {
    const { onClose } = renderModal();

    fireEvent.change(screen.getByLabelText("What do you want to build?"), {
      target: { value: "Build a mission planning workflow" },
    });
    fireEvent.click(screen.getByText("Start Interview"));

    await waitFor(() => {
      expect(streamHandlers).toBeDefined();
    });

    act(() => {
      streamHandlers.onQuestion?.(SAMPLE_QUESTION);
    });

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockCancelMissionInterview).not.toHaveBeenCalled();
  });

  it("closes from the backdrop after overlay mousedown", () => {
    const { onClose } = renderModal();
    const overlay = screen.getByRole("dialog");

    fireEvent.mouseDown(overlay);
    fireEvent.click(overlay);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockCancelMissionInterview).not.toHaveBeenCalled();
  });

  it("allows typing in textarea without resetting to stale persisted goal", async () => {
    // Simulate a stale persisted goal from a previous session
    mockGetMissionGoal.mockReturnValue("Old stale goal");

    renderModal();

    const textarea = screen.getByLabelText("What do you want to build?");
    expect(textarea).toHaveValue("Old stale goal");

    // User starts typing a new goal
    fireEvent.change(textarea, { target: { value: "New mission" } });
    expect(textarea).toHaveValue("New mission");

    // Type more characters — the stale value should NOT overwrite
    fireEvent.change(textarea, { target: { value: "New mission idea" } });
    expect(textarea).toHaveValue("New mission idea");

    // Even after a re-render cycle, user input should persist
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(textarea).toHaveValue("New mission idea");
  });
});
