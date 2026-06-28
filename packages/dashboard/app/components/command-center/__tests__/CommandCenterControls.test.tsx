import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { CommandCenterControls } from "../CommandCenterControls";
import { COLOR_THEMES } from "../../themeOptions";
import { ConfirmDialogProvider } from "../../../hooks/useConfirm";

const commandCenterControlsCss = readFileSync(
  join(process.cwd(), "app/components/command-center/CommandCenterControls.css"),
  "utf8",
);

const mocks = vi.hoisted(() => ({
  fetchSettings: vi.fn(),
  fetchConfig: vi.fn(),
  fetchGlobalConcurrency: vi.fn(),
  updateSettings: vi.fn(),
  updateGlobalConcurrency: vi.fn(),
  toggleGlobalPause: vi.fn(),
  toggleEnginePause: vi.fn(),
  refresh: vi.fn(),
  appSettings: {
    globalPaused: false,
    enginePaused: false,
  },
}));

vi.mock("../../../api/legacy", () => ({
  fetchSettings: mocks.fetchSettings,
  fetchConfig: mocks.fetchConfig,
  fetchGlobalConcurrency: mocks.fetchGlobalConcurrency,
  updateSettings: mocks.updateSettings,
  updateGlobalConcurrency: mocks.updateGlobalConcurrency,
}));

vi.mock("../../../hooks/useAppSettings", () => ({
  useAppSettings: () => ({
    globalPaused: mocks.appSettings.globalPaused,
    enginePaused: mocks.appSettings.enginePaused,
    toggleGlobalPause: mocks.toggleGlobalPause,
    toggleEnginePause: mocks.toggleEnginePause,
    refresh: mocks.refresh,
  }),
}));

function renderControls(projectId?: string) {
  return render(
    <ConfirmDialogProvider>
      <CommandCenterControls
        projectId={projectId}
        colorTheme="default"
        themeMode="dark"
        onColorThemeChange={vi.fn()}
        onThemeModeChange={vi.fn()}
      />
    </ConfirmDialogProvider>,
  );
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function advanceConfirmDebounce() {
  await act(async () => {
    vi.advanceTimersByTime(500);
    await Promise.resolve();
  });
}

function getConfirmDialog() {
  return screen.getByRole("dialog", { name: /confirm concurrency change/i });
}

async function clickConfirmSave() {
  fireEvent.click(within(getConfirmDialog()).getByRole("button", { name: /save change/i }));
  await flushPromises();
}

async function clickConfirmCancel() {
  fireEvent.click(within(getConfirmDialog()).getByRole("button", { name: /cancel/i }));
  await flushPromises();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.appSettings.globalPaused = false;
  mocks.appSettings.enginePaused = false;
  mocks.fetchSettings.mockResolvedValue({ maxConcurrent: 2, maxTriageConcurrent: 2, maxWorktrees: 4 });
  mocks.fetchConfig.mockResolvedValue({ maxConcurrent: 2, rootDir: "/repo" });
  mocks.fetchGlobalConcurrency.mockResolvedValue({
    globalMaxConcurrent: 8,
    currentlyActive: 3,
    queuedCount: 0,
    projectsActive: { "project-a": 2 },
  });
  mocks.updateSettings.mockResolvedValue({});
  mocks.updateGlobalConcurrency.mockResolvedValue({});
  mocks.refresh.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CommandCenterControls", () => {
  it("renders only overview controls after team affordances move", async () => {
    renderControls(undefined);

    await flushPromises();
    expect(screen.getByTestId("command-center-controls")).toBeDefined();
    expect(screen.queryByTestId("cc-controls-org-chart")).toBeNull();
    expect(screen.queryByTestId("cc-controls-heartbeat")).toBeNull();
    expect(screen.getByTestId("cc-controls-engine")).toBeDefined();
    expect(screen.getByTestId("cc-controls-concurrency")).toBeDefined();
    expect(screen.getByTestId("cc-controls-theme")).toBeDefined();
  });

  it("engine controls call the existing settings toggle", async () => {
    renderControls("project-a");

    await flushPromises();
    fireEvent.click(screen.getByRole("button", { name: /stop ai engine/i }));
    expect(mocks.toggleGlobalPause).toHaveBeenCalledTimes(1);
    expect(mocks.toggleEnginePause).not.toHaveBeenCalled();
  });

  it("shows loaded global and current-project running counts and use markers", async () => {
    renderControls("project-a");

    await flushPromises();
    const section = screen.getByTestId("cc-controls-concurrency");

    expect(within(section).getByTestId("cc-global-running")).toHaveTextContent("3 running (all projects)");
    expect(within(section).getByTestId("cc-project-running")).toHaveTextContent("2 running (this project)");
    expect(within(section).getByTestId("cc-global-use-marker").style.getPropertyValue("--use-pct")).toBe(`${(3 / 32) * 100}%`);
    expect(within(section).getByTestId("cc-project-use-marker").style.getPropertyValue("--use-pct")).toBe(`${(2 / 50) * 100}%`);
    expect(within(section).queryAllByTestId(/cc-.*-use-marker/)).toHaveLength(2);
  });

  it("positions one active agent above zero on both use markers", async () => {
    mocks.fetchGlobalConcurrency.mockResolvedValueOnce({
      globalMaxConcurrent: 8,
      currentlyActive: 1,
      queuedCount: 0,
      projectsActive: { "project-a": 1 },
    });
    renderControls("project-a");

    await flushPromises();
    const section = screen.getByTestId("cc-controls-concurrency");

    expect(within(section).getByTestId("cc-global-use-marker").style.getPropertyValue("--use-pct")).toBe(`${(1 / 32) * 100}%`);
    expect(within(section).getByTestId("cc-project-use-marker").style.getPropertyValue("--use-pct")).toBe(`${(1 / 50) * 100}%`);
    expect(within(section).getByTestId("cc-global-use-marker").style.getPropertyValue("--use-pct")).not.toBe("0%");
    expect(within(section).getByTestId("cc-project-use-marker").style.getPropertyValue("--use-pct")).not.toBe("0%");
  });

  it("shows truthful zero or missing project running counts only after utilization loads", async () => {
    mocks.fetchGlobalConcurrency.mockResolvedValueOnce({
      globalMaxConcurrent: 8,
      currentlyActive: 0,
      queuedCount: 0,
      projectsActive: {},
    });
    renderControls(undefined);

    await flushPromises();
    const section = screen.getByTestId("cc-controls-concurrency");

    expect(within(section).getByTestId("cc-global-running")).toHaveTextContent("0 running (all projects)");
    expect(within(section).getByTestId("cc-project-running")).toHaveTextContent("0 running (this project)");
    expect(within(section).getByTestId("cc-global-use-marker").style.getPropertyValue("--use-pct")).toBe("0%");
    expect(within(section).getByTestId("cc-project-use-marker").style.getPropertyValue("--use-pct")).toBe("0%");
  });

  it("clamps over-subscribed current-use markers while keeping truthful counts", async () => {
    mocks.fetchSettings.mockResolvedValueOnce({ maxConcurrent: 4, maxTriageConcurrent: 2, maxWorktrees: 4 });
    mocks.fetchGlobalConcurrency.mockResolvedValueOnce({
      globalMaxConcurrent: 8,
      currentlyActive: 60,
      queuedCount: 0,
      projectsActive: { "project-a": 60 },
    });
    renderControls("project-a");

    await flushPromises();
    const section = screen.getByTestId("cc-controls-concurrency");

    expect(within(section).getByTestId("cc-global-running")).toHaveTextContent("60 running (all projects)");
    expect(within(section).getByTestId("cc-project-running")).toHaveTextContent("60 running (this project)");
    expect(within(section).getByTestId("cc-global-use-marker").style.getPropertyValue("--use-pct")).toBe("100%");
    expect(within(section).getByTestId("cc-project-use-marker").style.getPropertyValue("--use-pct")).toBe("100%");
  });

  it("suppresses running counts before global utilization finishes loading", async () => {
    let resolveGlobalConcurrency!: (value: { globalMaxConcurrent: number; currentlyActive: number; queuedCount: number; projectsActive: Record<string, number> }) => void;
    mocks.fetchGlobalConcurrency.mockReturnValueOnce(new Promise((resolve) => {
      resolveGlobalConcurrency = resolve;
    }));
    renderControls("project-a");
    const section = screen.getByTestId("cc-controls-concurrency");

    expect(within(section).queryByTestId("cc-global-running")).toBeNull();
    expect(within(section).queryByTestId("cc-project-running")).toBeNull();
    expect(within(section).queryByTestId("cc-global-use-marker")).toBeNull();
    expect(within(section).queryByTestId("cc-project-use-marker")).toBeNull();

    resolveGlobalConcurrency({ globalMaxConcurrent: 8, currentlyActive: 1, queuedCount: 0, projectsActive: {} });
    await flushPromises();
  });

  it("suppresses running counts while global utilization is unavailable", async () => {
    mocks.fetchGlobalConcurrency.mockRejectedValueOnce(new Error("global unavailable"));
    renderControls("project-a");

    await flushPromises();
    const section = screen.getByTestId("cc-controls-concurrency");

    expect(within(section).queryByTestId("cc-global-running")).toBeNull();
    expect(within(section).queryByTestId("cc-project-running")).toBeNull();
    expect(within(section).queryByTestId("cc-global-use-marker")).toBeNull();
    expect(within(section).queryByTestId("cc-project-use-marker")).toBeNull();
  });

  it("gates the global cap slider behind confirmation before persisting", async () => {
    renderControls("project-a");

    await flushPromises();
    const section = screen.getByTestId("cc-controls-concurrency");
    const slider = within(section).getByLabelText(/global max concurrent/i) as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "10" } });

    await advanceConfirmDebounce();

    expect(getConfirmDialog()).toHaveTextContent("Change Global Max Concurrent from 8 to 10?");
    expect(mocks.updateGlobalConcurrency).not.toHaveBeenCalled();
    expect(mocks.updateSettings).not.toHaveBeenCalled();

    await clickConfirmSave();
    await advanceConfirmDebounce();

    expect(mocks.updateGlobalConcurrency).toHaveBeenCalledWith({ globalMaxConcurrent: 10 });
    expect(mocks.updateGlobalConcurrency).toHaveBeenCalledTimes(1);
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "Max concurrent tasks",
      label: /max concurrent tasks/i,
      value: "7",
      expected: { maxConcurrent: 7, maxTriageConcurrent: 2, maxWorktrees: 4 },
    },
    {
      name: "Max triage concurrent",
      label: /max triage concurrent/i,
      value: "6",
      expected: { maxConcurrent: 2, maxTriageConcurrent: 6, maxWorktrees: 4 },
    },
    {
      name: "Max worktrees",
      label: /max worktrees/i,
      value: "12",
      expected: { maxConcurrent: 2, maxTriageConcurrent: 2, maxWorktrees: 12 },
    },
  ])("gates the $name slider behind confirmation before persisting", async ({ name, label, value, expected }) => {
    renderControls("project-a");

    await flushPromises();
    const section = screen.getByTestId("cc-controls-concurrency");
    const slider = within(section).getByLabelText(label) as HTMLInputElement;
    fireEvent.change(slider, { target: { value } });

    await advanceConfirmDebounce();

    expect(getConfirmDialog()).toHaveTextContent(`Change ${name} from ${name === "Max worktrees" ? 4 : 2} to ${value}?`);
    expect(mocks.updateSettings).not.toHaveBeenCalled();

    await clickConfirmSave();

    expect(mocks.updateSettings).toHaveBeenCalledWith(expected, "project-a");
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("confirms all per-project slider changes made inside one debounce before persisting", async () => {
    renderControls("project-a");

    await flushPromises();
    const section = screen.getByTestId("cc-controls-concurrency");
    fireEvent.change(within(section).getByLabelText(/max concurrent tasks/i), { target: { value: "7" } });
    fireEvent.change(within(section).getByLabelText(/max worktrees/i), { target: { value: "12" } });

    await advanceConfirmDebounce();

    const dialog = getConfirmDialog();
    expect(dialog).toHaveTextContent("Change these concurrency settings");
    expect(dialog).toHaveTextContent("Max concurrent tasks from 2 to 7");
    expect(dialog).toHaveTextContent("Max worktrees from 4 to 12");
    expect(mocks.updateSettings).not.toHaveBeenCalled();

    await clickConfirmSave();

    expect(mocks.updateSettings).toHaveBeenCalledWith(
      { maxConcurrent: 7, maxTriageConcurrent: 2, maxWorktrees: 12 },
      "project-a",
    );
  });

  it("persists concurrency slider changes at the default maximum of 50 after confirmation", async () => {
    renderControls("project-a");

    await flushPromises();
    const section = screen.getByTestId("cc-controls-concurrency");
    const slider = within(section).getByLabelText(/max concurrent tasks/i);
    fireEvent.change(slider, { target: { value: "50" } });

    await advanceConfirmDebounce();
    await clickConfirmSave();

    expect(mocks.updateSettings).toHaveBeenCalledWith(
      { maxConcurrent: 50, maxTriageConcurrent: 2, maxWorktrees: 4 },
      "project-a",
    );
  });

  it("persists concurrency slider changes without a project id after confirmation", async () => {
    renderControls(undefined);

    await flushPromises();
    const section = screen.getByTestId("cc-controls-concurrency");
    const slider = within(section).getByLabelText(/max worktrees/i);
    fireEvent.change(slider, { target: { value: "12" } });

    await advanceConfirmDebounce();
    await clickConfirmSave();

    expect(mocks.updateSettings).toHaveBeenCalledWith(
      { maxConcurrent: 2, maxTriageConcurrent: 2, maxWorktrees: 12 },
      undefined,
    );
  });

  it("cancels per-project concurrency changes and reverts the slider without saving", async () => {
    renderControls("project-a");

    await flushPromises();
    const section = screen.getByTestId("cc-controls-concurrency");
    const slider = within(section).getByLabelText(/max concurrent tasks/i) as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "9" } });
    expect(slider.value).toBe("9");

    await advanceConfirmDebounce();
    await clickConfirmCancel();

    expect(slider.value).toBe("2");
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it("dismisses per-project concurrency changes with Escape and reverts without saving", async () => {
    renderControls("project-a");

    await flushPromises();
    const section = screen.getByTestId("cc-controls-concurrency");
    const slider = within(section).getByLabelText(/max triage concurrent/i) as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "5" } });

    await advanceConfirmDebounce();
    fireEvent.keyDown(document, { key: "Escape" });
    await flushPromises();

    expect(slider.value).toBe("2");
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it("dismisses global concurrency changes via backdrop and reverts without saving", async () => {
    renderControls("project-a");

    await flushPromises();
    const section = screen.getByTestId("cc-controls-concurrency");
    const slider = within(section).getByLabelText(/global max concurrent/i) as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "11" } });
    expect(slider.value).toBe("11");

    await advanceConfirmDebounce();
    fireEvent.click(getConfirmDialog().parentElement!);
    await flushPromises();

    expect(slider.value).toBe("8");
    await advanceConfirmDebounce();
    expect(mocks.updateGlobalConcurrency).not.toHaveBeenCalled();
  });

  it("does not open a confirmation or save for no-op slider settles", async () => {
    renderControls("project-a");

    await flushPromises();
    const section = screen.getByTestId("cc-controls-concurrency");
    fireEvent.change(within(section).getByLabelText(/global max concurrent/i), { target: { value: "8" } });
    fireEvent.change(within(section).getByLabelText(/max worktrees/i), { target: { value: "4" } });

    await advanceConfirmDebounce();

    expect(screen.queryByRole("dialog", { name: /confirm concurrency change/i })).toBeNull();
    expect(mocks.updateGlobalConcurrency).not.toHaveBeenCalled();
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it("renders persisted concurrency settings without stale default drift", async () => {
    mocks.fetchSettings.mockResolvedValueOnce({ maxConcurrent: 6, maxTriageConcurrent: 3, maxWorktrees: 9 });

    renderControls("project-a");

    await flushPromises();
    const section = screen.getByTestId("cc-controls-concurrency");
    const maxConcurrent = within(section).getByLabelText(/max concurrent tasks/i) as HTMLInputElement;
    const maxTriageConcurrent = within(section).getByLabelText(/max triage concurrent/i) as HTMLInputElement;
    const maxWorktrees = within(section).getByLabelText(/max worktrees/i) as HTMLInputElement;

    expect(maxConcurrent.value).toBe("6");
    expect(maxConcurrent.closest("label")).toHaveTextContent("Max concurrent tasks6");
    expect(maxTriageConcurrent.value).toBe("3");
    expect(maxTriageConcurrent.closest("label")).toHaveTextContent("Max triage concurrent3");
    expect(maxWorktrees.value).toBe("9");
    expect(maxWorktrees.closest("label")).toHaveTextContent("Max worktrees9");
  });

  it("sets all concurrency slider maximums to 50 for default and in-range settings", async () => {
    const defaultRender = renderControls("project-a");

    await flushPromises();
    const section = screen.getByTestId("cc-controls-concurrency");
    const sliders = [
      within(section).getByLabelText(/max concurrent tasks/i),
      within(section).getByLabelText(/max triage concurrent/i),
      within(section).getByLabelText(/max worktrees/i),
    ] as HTMLInputElement[];

    for (const slider of sliders) {
      expect(slider.max).toBe("50");
    }

    defaultRender.unmount();
    mocks.fetchSettings.mockResolvedValueOnce({ maxConcurrent: 50, maxTriageConcurrent: 49, maxWorktrees: 48 });
    renderControls("project-b");

    await flushPromises();
    const inRangeSection = screen.getByTestId("cc-controls-concurrency");
    const inRangeSliders = [
      within(inRangeSection).getByLabelText(/max concurrent tasks/i),
      within(inRangeSection).getByLabelText(/max triage concurrent/i),
      within(inRangeSection).getByLabelText(/max worktrees/i),
    ] as HTMLInputElement[];

    for (const slider of inRangeSliders) {
      expect(slider.max).toBe("50");
    }
  });

  it("keeps out-of-range persisted concurrency values visible instead of silently clamping", async () => {
    mocks.fetchSettings.mockResolvedValueOnce({ maxConcurrent: 60, maxTriageConcurrent: 70, maxWorktrees: 80 });

    renderControls("project-a");

    await flushPromises();
    const section = screen.getByTestId("cc-controls-concurrency");
    const maxConcurrent = within(section).getByLabelText(/max concurrent tasks/i) as HTMLInputElement;
    const maxTriageConcurrent = within(section).getByLabelText(/max triage concurrent/i) as HTMLInputElement;
    const maxWorktrees = within(section).getByLabelText(/max worktrees/i) as HTMLInputElement;

    expect(maxConcurrent.value).toBe("60");
    expect(maxConcurrent.max).toBe("60");
    expect(maxConcurrent.closest("label")).toHaveTextContent("Max concurrent tasks60");
    expect(maxTriageConcurrent.value).toBe("70");
    expect(maxTriageConcurrent.max).toBe("70");
    expect(maxTriageConcurrent.closest("label")).toHaveTextContent("Max triage concurrent70");
    expect(maxWorktrees.value).toBe("80");
    expect(maxWorktrees.max).toBe("80");
    expect(maxWorktrees.closest("label")).toHaveTextContent("Max worktrees80");
  });

  it("marks concurrency sliders with the mobile touch-drag affordance contract", async () => {
    renderControls("project-a");

    await flushPromises();
    const section = screen.getByTestId("cc-controls-concurrency");
    const sliders = [
      within(section).getByLabelText(/global max concurrent/i),
      within(section).getByLabelText(/max concurrent tasks/i),
      within(section).getByLabelText(/max triage concurrent/i),
      within(section).getByLabelText(/max worktrees/i),
    ];

    for (const slider of sliders) {
      expect(slider).toHaveClass("cc-controls-touch-slider");
    }
    // jsdom cannot simulate whether a touch drag is captured by page scrolling, so this verifies the CSS contract that enables horizontal thumb drags on mobile.
    expect(commandCenterControlsCss).toContain("touch-action: pan-y");
    expect(commandCenterControlsCss).toContain("pointer-events: none");
    expect(commandCenterControlsCss).toContain("inset-inline-start: var(--use-offset, var(--use-pct))");
    expect(commandCenterControlsCss).toContain("@media (max-width: 768px)");
    expect(commandCenterControlsCss).toContain("min-block-size: var(--space-2xl)");
    expect(commandCenterControlsCss).toContain("--cc-controls-range-thumb-size: var(--space-xl)");
  });

  it("shows save error indicator when concurrency update fails", async () => {
    mocks.updateSettings.mockRejectedValueOnce(new Error("network error"));
    renderControls("project-a");

    await flushPromises();
    const section = screen.getByTestId("cc-controls-concurrency");
    const slider = within(section).getByLabelText(/max concurrent tasks/i);
    fireEvent.change(slider, { target: { value: "8" } });

    await advanceConfirmDebounce();
    await clickConfirmSave();

    expect(within(section).getByText(/save failed/i)).toBeDefined();
  });

  it("selects a theme from the embedded dropdown", async () => {
    const onColorThemeChange = vi.fn();
    render(
      <CommandCenterControls
        colorTheme="default"
        themeMode="dark"
        onColorThemeChange={onColorThemeChange}
        onThemeModeChange={vi.fn()}
      />,
    );

    await flushPromises();
    /*
    FNXC:Theme 2026-06-25-16:55:
    Command Center embeds the shared theme dropdown, whose trigger label follows the current theme copy; look up the default label from theme metadata instead of assuming user-facing text contains "Default".
    */
    const defaultTheme = COLOR_THEMES.find((theme) => theme.value === "default")!;
    fireEvent.click(screen.getByRole("button", { name: defaultTheme.label }));
    fireEvent.click(screen.getAllByRole("option").find((element) => element.textContent?.trim() === "Forest")!);

    expect(onColorThemeChange).toHaveBeenCalledWith("forest");
  });
});
