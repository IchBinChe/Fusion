import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { EngineControlMenu } from "../EngineControlMenu";

const defaultSettings = {
  maxConcurrent: 2,
  maxTriageConcurrent: 1,
  maxWorktrees: 4,
  globalPause: false,
  enginePaused: false,
  autoMerge: true,
  experimentalFeatures: {},
};

const apiMocks = vi.hoisted(() => ({
  fetchConfig: vi.fn(),
  fetchSettings: vi.fn(),
  updateSettings: vi.fn(),
  updateGlobalSettings: vi.fn(),
}));

const legacyMocks = vi.hoisted(() => ({
  fetchConfig: vi.fn(),
  fetchSettings: vi.fn(),
  updateSettings: vi.fn(),
  fetchGlobalConcurrency: vi.fn(),
  updateGlobalConcurrency: vi.fn(),
}));

vi.mock("../../api", () => apiMocks);
vi.mock("../../api/legacy", () => legacyMocks);
vi.mock("../../versionCheck", () => ({
  setAutoReloadEnabled: vi.fn(),
}));

async function openMenu(projectId: string | undefined = "proj_123") {
  render(<EngineControlMenu projectId={projectId} />);
  fireEvent.click(screen.getByTestId("engine-control-menu-trigger"));
  await screen.findByTestId("engine-control-menu");
}

function mockGlobalConcurrency(overrides: Partial<{
  globalMaxConcurrent: number;
  currentlyActive: number;
  queuedCount: number;
  projectsActive: Record<string, number>;
}> = {}) {
  legacyMocks.fetchGlobalConcurrency.mockResolvedValue({
    globalMaxConcurrent: 6,
    currentlyActive: 3,
    queuedCount: 0,
    projectsActive: { proj_123: 2 },
    ...overrides,
  });
}

describe("EngineControlMenu", () => {
  beforeEach(() => {
    vi.useRealTimers();
    apiMocks.fetchConfig.mockResolvedValue({ maxConcurrent: 2, rootDir: "/workspace/project" });
    apiMocks.fetchSettings.mockResolvedValue({ ...defaultSettings });
    apiMocks.updateSettings.mockResolvedValue({ ...defaultSettings });
    apiMocks.updateGlobalSettings.mockResolvedValue({});
    legacyMocks.fetchConfig.mockResolvedValue({ maxConcurrent: 2, rootDir: "/workspace/project" });
    legacyMocks.fetchSettings.mockResolvedValue({ ...defaultSettings });
    legacyMocks.updateSettings.mockResolvedValue({ ...defaultSettings });
    mockGlobalConcurrency();
    legacyMocks.updateGlobalConcurrency.mockResolvedValue({
      globalMaxConcurrent: 6,
      currentlyActive: 3,
      queuedCount: 0,
      projectsActive: { proj_123: 2 },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("renders an explicit close button when opened", async () => {
    await openMenu();

    expect(screen.getByTestId("engine-control-menu-close")).toBeInTheDocument();
    expect(screen.getByLabelText(/close engine controls/i)).toBeInTheDocument();
  });

  it("closes the menu when the explicit close button is clicked", async () => {
    await openMenu();

    fireEvent.click(screen.getByTestId("engine-control-menu-close"));

    await waitFor(() => expect(screen.queryByTestId("engine-control-menu")).not.toBeInTheDocument());
  });

  it("flushes pending project concurrency changes when the explicit close button is clicked", async () => {
    await openMenu();

    const maxConcurrent = await screen.findByLabelText(/max concurrent tasks/i);
    vi.useFakeTimers();

    fireEvent.change(maxConcurrent, { target: { value: "7" } });
    fireEvent.click(screen.getByTestId("engine-control-menu-close"));

    expect(legacyMocks.updateSettings).toHaveBeenCalledWith(
      { maxConcurrent: 7, maxTriageConcurrent: 1, maxWorktrees: 4 },
      "proj_123",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(legacyMocks.updateSettings).toHaveBeenCalledTimes(1);
  });

  it("keeps the close button available when concurrency settings fail to load", async () => {
    legacyMocks.fetchSettings.mockRejectedValue(new Error("settings unavailable"));
    await openMenu();

    expect(await screen.findByRole("alert")).toHaveTextContent("settings unavailable");
    expect(screen.getByTestId("engine-control-menu-close")).toBeInTheDocument();
  });

  it("stops and starts the global AI engine via settings", async () => {
    apiMocks.fetchSettings.mockResolvedValue({ ...defaultSettings, globalPause: false });
    await openMenu();

    fireEvent.click(screen.getByTestId("engine-control-stop-btn"));

    await waitFor(() => expect(apiMocks.updateSettings).toHaveBeenCalledWith(
      { globalPause: true, globalPauseReason: "manual" },
      "proj_123",
    ));
  });

  it("starts the global AI engine when currently stopped", async () => {
    apiMocks.fetchSettings.mockResolvedValue({ ...defaultSettings, globalPause: true });
    await openMenu();

    await waitFor(() => expect(screen.getByTestId("engine-control-stop-btn")).toHaveTextContent(/start ai engine/i));
    fireEvent.click(screen.getByTestId("engine-control-stop-btn"));

    await waitFor(() => expect(apiMocks.updateSettings).toHaveBeenCalledWith(
      { globalPause: false, globalPauseReason: undefined },
      "proj_123",
    ));
  });

  it("pauses and resumes triage, and disables triage while globally stopped", async () => {
    apiMocks.fetchSettings.mockResolvedValue({ ...defaultSettings, enginePaused: false });
    await openMenu();

    fireEvent.click(screen.getByTestId("engine-control-pause-triage-btn"));

    await waitFor(() => expect(apiMocks.updateSettings).toHaveBeenCalledWith({ enginePaused: true }, "proj_123"));

    vi.clearAllMocks();
    apiMocks.fetchConfig.mockResolvedValue({ maxConcurrent: 2, rootDir: "/workspace/project" });
    apiMocks.fetchSettings.mockResolvedValue({ ...defaultSettings, globalPause: true, enginePaused: true });
    legacyMocks.fetchConfig.mockResolvedValue({ maxConcurrent: 2, rootDir: "/workspace/project" });
    legacyMocks.fetchSettings.mockResolvedValue({ ...defaultSettings });
    render(<EngineControlMenu projectId="proj_123" />);
    fireEvent.click(screen.getAllByTestId("engine-control-menu-trigger")[1]);

    await waitFor(() => expect(screen.getAllByTestId("engine-control-pause-triage-btn")).toHaveLength(2));
    const pauseButton = screen.getAllByTestId("engine-control-pause-triage-btn")[1];
    await waitFor(() => expect(pauseButton).toBeDisabled());
    expect(pauseButton).toHaveTextContent(/resume scheduling/i);
  });

  it("persists debounced concurrency and worktree slider changes and refreshes settings", async () => {
    legacyMocks.fetchSettings.mockResolvedValue({
      ...defaultSettings,
      maxConcurrent: 60,
      maxTriageConcurrent: 70,
      maxWorktrees: 80,
    });
    await openMenu();

    const maxConcurrent = await screen.findByLabelText(/max concurrent tasks/i);
    const maxTriage = screen.getByLabelText(/max triage concurrent/i);
    const maxWorktrees = screen.getByLabelText(/max worktrees/i);

    vi.useFakeTimers();

    expect(maxConcurrent).toHaveAttribute("max", "60");
    expect(maxConcurrent).toHaveValue("60");
    expect(maxTriage).toHaveAttribute("max", "70");
    expect(maxTriage).toHaveValue("70");
    expect(maxWorktrees).toHaveAttribute("max", "80");
    expect(maxWorktrees).toHaveValue("80");

    fireEvent.change(maxConcurrent, { target: { value: "9" } });
    fireEvent.change(maxTriage, { target: { value: "4" } });
    fireEvent.change(maxWorktrees, { target: { value: "8" } });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(legacyMocks.updateSettings).toHaveBeenCalledWith(
      { maxConcurrent: 9, maxTriageConcurrent: 4, maxWorktrees: 8 },
      "proj_123",
    );
    expect(apiMocks.fetchSettings).toHaveBeenCalledTimes(2);
  });

  it("uses a 50 max for all in-range concurrency sliders", async () => {
    legacyMocks.fetchSettings.mockResolvedValue({
      ...defaultSettings,
      maxConcurrent: 12,
      maxTriageConcurrent: 3,
      maxWorktrees: 25,
    });
    await openMenu();

    expect(await screen.findByLabelText(/max concurrent tasks/i)).toHaveAttribute("max", "50");
    expect(screen.getByLabelText(/max triage concurrent/i)).toHaveAttribute("max", "50");
    expect(screen.getByLabelText(/max worktrees/i)).toHaveAttribute("max", "50");
  });

  it("renders running counts and current-use markers with clamped slider positions", async () => {
    legacyMocks.fetchSettings.mockResolvedValue({
      ...defaultSettings,
      maxConcurrent: 50,
    });
    mockGlobalConcurrency({
      globalMaxConcurrent: 40,
      currentlyActive: 40,
      projectsActive: { proj_123: 90 },
    });

    await openMenu();

    expect(await screen.findByTestId("engine-control-global-running")).toHaveTextContent("40 running (all projects)");
    expect(screen.getByTestId("engine-control-project-running")).toHaveTextContent("90 running (this project)");
    expect(screen.getByTestId("engine-control-global-use-marker")).toHaveStyle({ "--use-pct": "100%" });
    expect(screen.getByTestId("engine-control-project-use-marker")).toHaveStyle({ "--use-pct": "100%" });
  });

  it("positions current-use markers at zero and mid-track for representative running counts", async () => {
    mockGlobalConcurrency({
      globalMaxConcurrent: 33,
      currentlyActive: 17,
      projectsActive: { proj_123: 0 },
    });

    await openMenu();

    expect(await screen.findByTestId("engine-control-global-use-marker")).toHaveStyle({ "--use-pct": "50%" });
    expect(screen.getByTestId("engine-control-project-use-marker")).toHaveStyle({ "--use-pct": "0%" });
  });

  it("defaults the current-project running count to zero for empty projectsActive and missing projectId", async () => {
    mockGlobalConcurrency({
      globalMaxConcurrent: 6,
      currentlyActive: 0,
      projectsActive: {},
    });

    await openMenu(undefined);

    expect(await screen.findByTestId("engine-control-global-running")).toHaveTextContent("0 running (all projects)");
    expect(screen.getByTestId("engine-control-project-running")).toHaveTextContent("0 running (this project)");
    expect(screen.getByTestId("engine-control-global-use-marker")).toHaveStyle({ "--use-pct": "0%" });
    expect(screen.getByTestId("engine-control-project-use-marker")).toHaveStyle({ "--use-pct": "0%" });
  });

  it("does not render running counts or markers while global concurrency is loading", async () => {
    let resolveGlobalConcurrency!: (value: {
      globalMaxConcurrent: number;
      currentlyActive: number;
      queuedCount: number;
      projectsActive: Record<string, number>;
    }) => void;
    legacyMocks.fetchGlobalConcurrency.mockReturnValue(new Promise((resolve) => {
      resolveGlobalConcurrency = resolve;
    }));

    await openMenu();

    expect(screen.queryByTestId("engine-control-global-running")).not.toBeInTheDocument();
    expect(screen.queryByTestId("engine-control-project-running")).not.toBeInTheDocument();
    expect(screen.queryByTestId("engine-control-global-use-marker")).not.toBeInTheDocument();
    expect(screen.queryByTestId("engine-control-project-use-marker")).not.toBeInTheDocument();

    await act(async () => {
      resolveGlobalConcurrency({
        globalMaxConcurrent: 6,
        currentlyActive: 3,
        queuedCount: 0,
        projectsActive: { proj_123: 2 },
      });
    });
  });

  it("does not render running counts or markers when global concurrency fails to load", async () => {
    legacyMocks.fetchGlobalConcurrency.mockRejectedValue(new Error("global concurrency unavailable"));

    await openMenu();

    await screen.findByRole("alert");
    expect(screen.queryByTestId("engine-control-global-running")).not.toBeInTheDocument();
    expect(screen.queryByTestId("engine-control-project-running")).not.toBeInTheDocument();
    expect(screen.queryByTestId("engine-control-global-use-marker")).not.toBeInTheDocument();
    expect(screen.queryByTestId("engine-control-project-use-marker")).not.toBeInTheDocument();
  });

  it("persists a slider value of 50 through the debounced settings save", async () => {
    await openMenu();

    const maxConcurrent = await screen.findByLabelText(/max concurrent tasks/i);
    vi.useFakeTimers();

    expect(maxConcurrent).toHaveAttribute("max", "50");

    fireEvent.change(maxConcurrent, { target: { value: "50" } });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(legacyMocks.updateSettings).toHaveBeenCalledWith(
      { maxConcurrent: 50, maxTriageConcurrent: 1, maxWorktrees: 4 },
      "proj_123",
    );
  });

  it("renders a load error state without crashing", async () => {
    legacyMocks.fetchSettings.mockRejectedValue(new Error("settings unavailable"));
    await openMenu();

    expect(await screen.findByRole("alert")).toHaveTextContent("settings unavailable");
  });
});
