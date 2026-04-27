import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { SystemStatsModal } from "../SystemStatsModal";

vi.mock("lucide-react", () => ({
  Monitor: () => <span data-testid="icon-monitor" />,
  RefreshCw: () => <span data-testid="icon-refresh" />,
  X: () => <span data-testid="icon-x" />,
}));

const mockFetchSystemStats = vi.fn();

vi.mock("../../api", () => ({
  fetchSystemStats: (...args: unknown[]) => mockFetchSystemStats(...args),
}));

const sampleStats = {
  systemStats: {
    rss: 5 * 1024 * 1024 * 1024,
    heapUsed: 900 * 1024 * 1024,
    heapTotal: 1200 * 1024 * 1024,
    heapLimit: 1000 * 1024 * 1024,
    external: 50 * 1024 * 1024,
    arrayBuffers: 20 * 1024 * 1024,
    cpuPercent: null,
    loadAvg: [1.2, 0.8, 0.5] as [number, number, number],
    cpuCount: 8,
    systemTotalMem: 10 * 1024 * 1024 * 1024,
    systemFreeMem: 1024 * 1024 * 1024,
    pid: 12345,
    nodeVersion: "v22.0.0",
    platform: "darwin/arm64",
  },
  taskStats: {
    total: 6,
    byColumn: {
      triage: 1,
      todo: 2,
      "in-progress": 1,
      "in-review": 1,
      done: 1,
      archived: 0,
    },
    active: 2,
    agents: {
      idle: 1,
      active: 2,
      running: 0,
      error: 1,
    },
  },
};

describe("SystemStatsModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows loading state while initial stats are fetched", async () => {
    mockFetchSystemStats.mockReturnValue(new Promise(() => undefined));

    render(<SystemStatsModal isOpen={true} onClose={vi.fn()} />);

    expect(await screen.findByText("Loading system stats…")).toBeDefined();
  });

  it("renders fetched metrics across all sections", async () => {
    mockFetchSystemStats.mockResolvedValue(sampleStats);

    render(<SystemStatsModal isOpen={true} onClose={vi.fn()} projectId="proj-1" />);

    await waitFor(() => {
      expect(mockFetchSystemStats).toHaveBeenCalledWith("proj-1");
    });

    expect(screen.getByText("System Stats")).toBeDefined();
    expect(screen.getByText("Process")).toBeDefined();
    expect(screen.getByText("CPU & Load")).toBeDefined();
    expect(screen.getByText("System")).toBeDefined();
    expect(screen.getByText("Tasks")).toBeDefined();
    expect(screen.getByText("Agents")).toBeDefined();

    expect(screen.getByText("5.00 GB")).toBeDefined();
    expect(screen.getByText("900 MB")).toBeDefined();
    expect(screen.getByText("9.00 GB")).toBeDefined();
    expect(screen.getByText("90.0% of 10.00 GB")).toBeDefined();
    expect(screen.getByText("1.20 0.80 0.50")).toBeDefined();

    const criticalValues = document.querySelectorAll(".system-stats-modal__value--critical");
    expect(criticalValues.length).toBeGreaterThan(0);
  });

  it("shows error state when initial fetch fails", async () => {
    mockFetchSystemStats.mockRejectedValue(new Error("stats unavailable"));

    render(<SystemStatsModal isOpen={true} onClose={vi.fn()} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("stats unavailable");
  });

  it("refreshes every 5 seconds while open and stops when closed", async () => {
    vi.useFakeTimers();
    mockFetchSystemStats.mockResolvedValue(sampleStats);

    const { rerender } = render(<SystemStatsModal isOpen={true} onClose={vi.fn()} />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(mockFetchSystemStats).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(mockFetchSystemStats).toHaveBeenCalledTimes(2);

    rerender(<SystemStatsModal isOpen={false} onClose={vi.fn()} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(mockFetchSystemStats).toHaveBeenCalledTimes(2);
  });
});
