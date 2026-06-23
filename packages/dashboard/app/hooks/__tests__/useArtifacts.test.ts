import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { ArtifactWithTask } from "@fusion/core";
import { fetchArtifacts } from "../../api";
import { useArtifacts } from "../useArtifacts";

vi.mock("../../api", () => ({
  fetchArtifacts: vi.fn(),
}));

const mockFetchArtifacts = vi.mocked(fetchArtifacts);

const mockArtifacts: ArtifactWithTask[] = [
  {
    id: "artifact-1",
    type: "image",
    title: "Screenshot",
    authorId: "agent-1",
    authorType: "agent",
    taskId: "FN-1",
    createdAt: "2026-06-21T00:00:00.000Z",
    updatedAt: "2026-06-21T00:00:00.000Z",
  },
];

describe("useArtifacts", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.localStorage.clear();
    mockFetchArtifacts.mockResolvedValue(mockArtifacts);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it("loads artifacts on initial mount", async () => {
    const { result } = renderHook(() => useArtifacts({ projectId: "project-1" }));

    expect(result.current.loading).toBe(true);
    expect(result.current.artifacts).toEqual([]);

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.artifacts).toEqual(mockArtifacts);
    expect(mockFetchArtifacts).toHaveBeenCalledWith({ q: undefined }, "project-1");
  });

  it("propagates filter parameters to fetchArtifacts", async () => {
    renderHook(() => useArtifacts({
      projectId: "project-2",
      type: "video",
      authorId: "agent-video",
      taskId: "FN-2",
      searchQuery: "demo",
    }));

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(mockFetchArtifacts).toHaveBeenCalledWith({
      type: "video",
      authorId: "agent-video",
      taskId: "FN-2",
      q: "demo",
    }, "project-2");
  });

  it("debounces search query changes", async () => {
    const { rerender } = renderHook(
      ({ searchQuery }) => useArtifacts({ projectId: "project-3", searchQuery }),
      { initialProps: { searchQuery: undefined as string | undefined } },
    );

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    mockFetchArtifacts.mockClear();
    rerender({ searchQuery: "alpha" });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(299);
    });
    expect(mockFetchArtifacts).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    await waitFor(() => {
      expect(mockFetchArtifacts).toHaveBeenCalledWith({ q: "alpha" }, "project-3");
    });
  });

  it("surfaces errors without clearing existing artifacts", async () => {
    mockFetchArtifacts.mockResolvedValueOnce(mockArtifacts);
    const { result } = renderHook(() => useArtifacts({ projectId: "project-4" }));

    await act(async () => {
      await vi.runAllTimersAsync();
    });
    await waitFor(() => expect(result.current.artifacts).toEqual(mockArtifacts));

    mockFetchArtifacts.mockRejectedValueOnce(new Error("Artifacts failed"));
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.error).toBe("Artifacts failed");
    expect(result.current.artifacts).toEqual(mockArtifacts);
  });

  it("refreshes artifacts on demand", async () => {
    const { result } = renderHook(() => useArtifacts({ projectId: "project-5" }));

    await act(async () => {
      await vi.runAllTimersAsync();
    });
    mockFetchArtifacts.mockClear();

    await act(async () => {
      await result.current.refresh();
    });

    expect(mockFetchArtifacts).toHaveBeenCalledTimes(1);
    expect(mockFetchArtifacts).toHaveBeenCalledWith({ q: undefined }, "project-5");
  });
});
