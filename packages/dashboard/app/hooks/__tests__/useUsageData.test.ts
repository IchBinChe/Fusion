import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useUsageData } from "../useUsageData";
import * as api from "../../api";

vi.mock("../../api", () => ({
  fetchUsageData: vi.fn(),
}));

const mockFetchUsageData = vi.mocked(api.fetchUsageData);

describe("useUsageData visibility change", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetchUsageData.mockReset();
    // Set default visibility state to visible
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (document as any).visibilityState;
  });

  function setVisibilityState(state: "visible" | "hidden") {
    Object.defineProperty(document, "visibilityState", {
      value: state,
      writable: true,
      configurable: true,
    });
  }

  it("does not refetch when visibility changes to hidden", async () => {
    const initialData = {
      providers: [{ name: "Claude", icon: "🟠", status: "ok" as const, windows: [] }],
    };
    mockFetchUsageData.mockResolvedValueOnce(initialData);

    renderHook(() => useUsageData({ autoRefresh: false }));

    await waitFor(() => {
      expect(mockFetchUsageData).toHaveBeenCalledTimes(1);
    });

    mockFetchUsageData.mockClear();

    setVisibilityState("hidden");

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(mockFetchUsageData).not.toHaveBeenCalled();
  });
});
