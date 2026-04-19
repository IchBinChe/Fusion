import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectDevServerStream,
  fetchDevServerHistory,
  fetchDevServerStatus,
  restartDevServer,
  startDevServer,
  stopDevServer,
  type DevServerLogEntry,
  type DevServerSnapshot,
  type DevServerState,
} from "../../api";
import { useDevServer } from "../useDevServer";

vi.mock("../../api", () => ({
  fetchDevServerStatus: vi.fn(),
  fetchDevServerHistory: vi.fn(),
  startDevServer: vi.fn(),
  stopDevServer: vi.fn(),
  restartDevServer: vi.fn(),
  connectDevServerStream: vi.fn(),
}));

const mockFetchDevServerStatus = vi.mocked(fetchDevServerStatus);
const mockFetchDevServerHistory = vi.mocked(fetchDevServerHistory);
const mockStartDevServer = vi.mocked(startDevServer);
const mockStopDevServer = vi.mocked(stopDevServer);
const mockRestartDevServer = vi.mocked(restartDevServer);
const mockConnectDevServerStream = vi.mocked(connectDevServerStream);

function createState(overrides: Partial<DevServerState> = {}): DevServerState {
  return {
    serverKey: "default",
    status: "stopped",
    command: "pnpm dev",
    scriptName: "dev",
    cwd: "/repo",
    pid: null,
    startedAt: null,
    updatedAt: "2026-04-19T10:00:00.000Z",
    previewUrl: null,
    previewProtocol: null,
    previewHost: null,
    previewPort: null,
    previewPath: null,
    exitCode: 0,
    exitSignal: null,
    exitedAt: "2026-04-19T10:00:00.000Z",
    failureReason: null,
    ...overrides,
  };
}

function createLog(message: string, timestamp: string): DevServerLogEntry {
  return {
    serverKey: "default",
    source: "stdout",
    message,
    timestamp,
  };
}

describe("useDevServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchDevServerStatus.mockResolvedValue({
      state: createState(),
      logs: [],
    } satisfies DevServerSnapshot);
    mockFetchDevServerHistory.mockResolvedValue({ logs: [] });
    mockStartDevServer.mockResolvedValue({ state: createState({ status: "running", pid: 1234 }) });
    mockStopDevServer.mockResolvedValue({ state: createState({ status: "stopped", pid: null }) });
    mockRestartDevServer.mockResolvedValue({ state: createState({ status: "running", pid: 4567 }) });
    mockConnectDevServerStream.mockImplementation((_projectId, handlers) => {
      return {
        close: vi.fn(),
        isConnected: () => true,
      };
    });
  });

  it("hydrates persisted status/history before attaching live stream", async () => {
    const statusLog = createLog("from-status", "2026-04-19T10:00:01.000Z");
    const historyLog = createLog("from-history", "2026-04-19T10:00:02.000Z");

    let resolveStatus: ((value: DevServerSnapshot) => void) | null = null;
    let resolveHistory: ((value: { logs: DevServerLogEntry[] }) => void) | null = null;

    mockFetchDevServerStatus.mockImplementationOnce(() => new Promise((resolve) => {
      resolveStatus = resolve;
    }));
    mockFetchDevServerHistory.mockImplementationOnce(() => new Promise((resolve) => {
      resolveHistory = resolve;
    }));

    const { result } = renderHook(() => useDevServer("project-a"));

    expect(mockConnectDevServerStream).not.toHaveBeenCalled();

    act(() => {
      resolveStatus?.({
        state: createState({ status: "running", pid: 1200 }),
        logs: [statusLog],
      });
      resolveHistory?.({ logs: [statusLog, historyLog] });
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.state.status).toBe("running");
    expect(result.current.logs.map((entry) => entry.message)).toEqual(["from-status", "from-history"]);
    expect(mockConnectDevServerStream).toHaveBeenCalledTimes(1);
  });

  it("deduplicates replayed log events after reconnect", async () => {
    const replayLog = createLog("replayed", "2026-04-19T10:00:03.000Z");
    mockFetchDevServerStatus.mockResolvedValueOnce({
      state: createState({ status: "running" }),
      logs: [replayLog],
    });
    mockFetchDevServerHistory.mockResolvedValueOnce({ logs: [replayLog] });

    let capturedHandlers: Parameters<typeof connectDevServerStream>[1] | null = null;
    mockConnectDevServerStream.mockImplementationOnce((_projectId, handlers) => {
      capturedHandlers = handlers;
      return {
        close: vi.fn(),
        isConnected: () => true,
      };
    });

    const { result } = renderHook(() => useDevServer("project-a"));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.logs).toHaveLength(1);

    act(() => {
      capturedHandlers?.onLog?.(replayLog);
      capturedHandlers?.onLog?.(createLog("new-log", "2026-04-19T10:00:04.000Z"));
    });

    expect(result.current.logs.map((entry) => entry.message)).toEqual(["replayed", "new-log"]);
  });

  it("clears stale state and reconnects when project changes", async () => {
    const closeA = vi.fn();

    mockFetchDevServerStatus
      .mockResolvedValueOnce({
        state: createState({ status: "running", previewUrl: "http://localhost:3001" }),
        logs: [createLog("project-a", "2026-04-19T10:10:00.000Z")],
      })
      .mockResolvedValueOnce({
        state: createState({ status: "stopped", previewUrl: null }),
        logs: [createLog("project-b", "2026-04-19T10:20:00.000Z")],
      });

    mockFetchDevServerHistory
      .mockResolvedValueOnce({ logs: [createLog("project-a", "2026-04-19T10:10:00.000Z")] })
      .mockResolvedValueOnce({ logs: [createLog("project-b", "2026-04-19T10:20:00.000Z")] });

    mockConnectDevServerStream
      .mockImplementationOnce(() => ({ close: closeA, isConnected: () => true }))
      .mockImplementationOnce(() => ({ close: vi.fn(), isConnected: () => true }));

    const { result, rerender } = renderHook(
      ({ projectId }) => useDevServer(projectId),
      { initialProps: { projectId: "project-a" as string | undefined } },
    );

    await waitFor(() => {
      expect(result.current.logs.map((entry) => entry.message)).toEqual(["project-a"]);
    });

    act(() => {
      result.current.setManualPreviewUrl("https://manual-preview.local");
    });
    expect(result.current.effectivePreviewUrl).toBe("https://manual-preview.local");

    rerender({ projectId: "project-b" });

    await waitFor(() => {
      expect(result.current.logs.map((entry) => entry.message)).toEqual(["project-b"]);
    });

    expect(closeA).toHaveBeenCalledTimes(1);
    expect(result.current.manualPreviewUrl).toBe("");
    expect(result.current.effectivePreviewUrl).toBeNull();
  });

  it("exposes start/stop/restart actions", async () => {
    const { result } = renderHook(() => useDevServer("project-a"));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.start({ command: "pnpm dev", scriptName: "dev" });
    });
    expect(mockStartDevServer).toHaveBeenCalledWith({ command: "pnpm dev", scriptName: "dev" }, "project-a");
    expect(result.current.state.status).toBe("running");

    await act(async () => {
      await result.current.restart({ command: "pnpm dev" });
    });
    expect(mockRestartDevServer).toHaveBeenCalledWith({ command: "pnpm dev" }, "project-a");

    await act(async () => {
      await result.current.stop();
    });
    expect(mockStopDevServer).toHaveBeenCalledWith("project-a");
    expect(result.current.state.status).toBe("stopped");
  });
});
