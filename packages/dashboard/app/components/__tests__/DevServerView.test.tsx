import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DevServerView } from "../DevServerView";

const mockUseDevServer = vi.fn();

vi.mock("../../hooks/useDevServer", () => ({
  useDevServer: (...args: unknown[]) => mockUseDevServer(...args),
}));

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    fetchScripts: vi.fn().mockResolvedValue({ dev: "pnpm dev" }),
  };
});

function createHookState(overrides: Record<string, unknown> = {}) {
  return {
    state: {
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
    },
    logs: [
      {
        serverKey: "default",
        source: "stdout",
        message: "ready",
        timestamp: "2026-04-19T10:00:01.000Z",
      },
    ],
    loading: false,
    error: null,
    connectionState: "connected",
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    manualPreviewUrl: "",
    setManualPreviewUrl: vi.fn(),
    effectivePreviewUrl: null,
    ...overrides,
  };
}

describe("DevServerView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseDevServer.mockReturnValue(createHookState());
  });

  it("renders status and log panels", () => {
    render(<DevServerView projectId="project-a" />);

    expect(screen.getByTestId("dev-server-status-panel")).toBeInTheDocument();
    expect(screen.getByTestId("dev-server-logs-panel")).toBeInTheDocument();
    expect(screen.getByText("ready")).toBeInTheDocument();
  });

  it("applies action button states for running and stopped statuses", () => {
    mockUseDevServer.mockReturnValue(createHookState({
      state: {
        ...createHookState().state,
        status: "running",
      },
    }));

    const { rerender } = render(<DevServerView projectId="project-a" />);

    expect(screen.getByTestId("dev-server-start-btn")).toBeDisabled();
    expect(screen.getByTestId("dev-server-stop-btn")).not.toBeDisabled();

    mockUseDevServer.mockReturnValue(createHookState({
      state: {
        ...createHookState().state,
        status: "failed",
      },
    }));

    rerender(<DevServerView projectId="project-a" />);

    expect(screen.getByTestId("dev-server-start-btn")).not.toBeDisabled();
    expect(screen.getByTestId("dev-server-stop-btn")).toBeDisabled();
  });

  it("supports manual preview URL override input", () => {
    const setManualPreviewUrl = vi.fn();
    mockUseDevServer.mockReturnValue(createHookState({
      manualPreviewUrl: "https://override.local",
      setManualPreviewUrl,
      effectivePreviewUrl: "https://override.local",
    }));

    render(<DevServerView projectId="project-a" />);

    const input = screen.getByTestId("dev-server-preview-url-input");
    fireEvent.change(input, { target: { value: "https://preview.local" } });
    expect(setManualPreviewUrl).toHaveBeenCalledWith("https://preview.local");
  });

  it("shows iframe blocked fallback messaging", () => {
    vi.useFakeTimers();
    mockUseDevServer.mockReturnValue(createHookState({
      state: {
        ...createHookState().state,
        status: "running",
        previewUrl: "http://127.0.0.1:5173",
      },
      effectivePreviewUrl: "http://127.0.0.1:5173",
    }));

    render(<DevServerView projectId="project-a" />);

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(screen.getByTestId("dev-server-preview-fallback")).toBeInTheDocument();
    vi.useRealTimers();
  });
});
