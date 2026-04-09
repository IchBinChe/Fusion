/**
 * Covers background AI session hook behavior: fetch lifecycle, SSE updates,
 * dismissal, counters/filters, refresh, and project scoping.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBackgroundSessions } from "../useBackgroundSessions";
import {
  __destroyAiSessionSyncStoreForTests,
  __resetAiSessionSyncStoreForTests,
} from "../useAiSessionSync";
import * as apiModule from "../../api";
import { MockEventSource } from "../../../vitest.setup";

vi.mock("../../api", () => ({
  fetchAiSessions: vi.fn(),
  deleteAiSession: vi.fn(),
}));

const mockFetchAiSessions = vi.mocked(apiModule.fetchAiSessions);
const mockDeleteAiSession = vi.mocked(apiModule.deleteAiSession);

function makeSession(overrides: Partial<apiModule.AiSessionSummary> & Pick<apiModule.AiSessionSummary, "id">): apiModule.AiSessionSummary {
  return {
    id: overrides.id,
    type: overrides.type ?? "planning",
    status: overrides.status ?? "generating",
    title: overrides.title ?? overrides.id,
    projectId: overrides.projectId ?? null,
    lockedByTab: overrides.lockedByTab ?? null,
    updatedAt: overrides.updatedAt ?? "2026-04-08T00:00:00.000Z",
  };
}

describe("useBackgroundSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetAiSessionSyncStoreForTests();
    __destroyAiSessionSyncStoreForTests();
    mockFetchAiSessions.mockResolvedValue([]);
    mockDeleteAiSession.mockResolvedValue(undefined);
  });

  afterEach(() => {
    __resetAiSessionSyncStoreForTests();
    __destroyAiSessionSyncStoreForTests();
  });

  it("fetches and filters initial sessions", async () => {
    mockFetchAiSessions.mockResolvedValueOnce([
      makeSession({ id: "s-generating", status: "generating" }),
      makeSession({ id: "s-awaiting", status: "awaiting_input" }),
      makeSession({ id: "s-complete", status: "complete" }),
      makeSession({ id: "s-error", status: "error" }),
      makeSession({ id: "s-ignored", status: "paused" as any }),
    ]);

    const { result } = renderHook(() => useBackgroundSessions());

    await waitFor(() => {
      expect(mockFetchAiSessions).toHaveBeenCalledWith(undefined);
    });

    await waitFor(() => {
      expect(result.current.sessions.map((session) => session.id).sort()).toEqual([
        "s-awaiting",
        "s-complete",
        "s-error",
        "s-generating",
      ]);
    });
  });

  it("applies SSE-driven session updates reactively", async () => {
    const { result } = renderHook(() => useBackgroundSessions());

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThan(0);
    });

    const eventSource = MockEventSource.instances[0]!;

    act(() => {
      eventSource._emit(
        "ai_session:updated",
        makeSession({
          id: "sse-session",
          type: "mission_interview",
          status: "generating",
          title: "Mission stream",
          updatedAt: "2026-04-08T00:00:01.000Z",
        }),
      );
    });

    await waitFor(() => {
      expect(result.current.sessions.find((session) => session.id === "sse-session")?.status).toBe(
        "generating",
      );
    });

    act(() => {
      eventSource._emit(
        "ai_session:updated",
        makeSession({
          id: "sse-session",
          type: "mission_interview",
          status: "awaiting_input",
          title: "Mission stream",
          updatedAt: "2026-04-08T00:00:02.000Z",
        }),
      );
    });

    await waitFor(() => {
      expect(result.current.sessions.find((session) => session.id === "sse-session")?.status).toBe(
        "awaiting_input",
      );
    });
  });

  it("removes sessions when ai_session:deleted SSE event arrives", async () => {
    mockFetchAiSessions.mockResolvedValueOnce([
      makeSession({ id: "delete-me", status: "awaiting_input" }),
    ]);

    const { result } = renderHook(() => useBackgroundSessions());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    const eventSource = MockEventSource.instances[0]!;
    act(() => {
      eventSource._emit("ai_session:deleted", "delete-me");
    });

    await waitFor(() => {
      expect(result.current.sessions).toEqual([]);
    });
  });

  it("dismissSession calls API and updates local state", async () => {
    mockFetchAiSessions.mockResolvedValueOnce([
      makeSession({ id: "dismiss-me", status: "awaiting_input" }),
    ]);

    const { result } = renderHook(() => useBackgroundSessions());

    await waitFor(() => {
      expect(result.current.sessions.map((session) => session.id)).toEqual(["dismiss-me"]);
    });

    act(() => {
      result.current.dismissSession("dismiss-me");
    });

    expect(mockDeleteAiSession).toHaveBeenCalledWith("dismiss-me");
    await waitFor(() => {
      expect(result.current.sessions).toEqual([]);
    });
  });

  it("returns accurate generating/needsInput counts and planningSessions filter", async () => {
    mockFetchAiSessions.mockResolvedValueOnce([
      makeSession({ id: "count-generating", status: "generating", type: "planning" }),
      makeSession({ id: "count-awaiting", status: "awaiting_input", type: "subtask" }),
      makeSession({ id: "count-error-plan", status: "error", type: "planning" }),
      makeSession({ id: "count-complete", status: "complete", type: "mission_interview" }),
    ]);

    const { result } = renderHook(() => useBackgroundSessions());

    await waitFor(() => {
      expect(result.current.generating).toBe(1);
      expect(result.current.needsInput).toBe(1);
      expect(result.current.planningSessions.map((session) => session.id).sort()).toEqual([
        "count-error-plan",
        "count-generating",
      ]);
    });
  });

  it("refresh triggers a new fetch and updates state", async () => {
    mockFetchAiSessions
      .mockResolvedValueOnce([makeSession({ id: "first-session", status: "generating" })])
      .mockResolvedValueOnce([makeSession({ id: "second-session", status: "awaiting_input" })]);

    const { result } = renderHook(() => useBackgroundSessions());

    await waitFor(() => {
      expect(result.current.sessions.map((session) => session.id)).toEqual(["first-session"]);
    });

    act(() => {
      result.current.refresh();
    });

    await waitFor(() => {
      expect(mockFetchAiSessions).toHaveBeenCalledTimes(2);
      expect(result.current.sessions.map((session) => session.id)).toEqual(["second-session"]);
    });
  });

  it("passes projectId to API fetch and uses project-scoped SSE URL", async () => {
    const projectId = "proj-123";
    renderHook(() => useBackgroundSessions(projectId));

    await waitFor(() => {
      expect(mockFetchAiSessions).toHaveBeenCalledWith(projectId);
    });

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThan(0);
    });

    expect(MockEventSource.instances[0]?.url).toContain(`/api/events?projectId=${encodeURIComponent(projectId)}`);
  });
});
