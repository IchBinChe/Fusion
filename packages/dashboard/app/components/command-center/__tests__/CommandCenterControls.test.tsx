import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { CommandCenterControls } from "../CommandCenterControls";

const commandCenterControlsCss = readFileSync(
  join(process.cwd(), "app/components/command-center/CommandCenterControls.css"),
  "utf8",
);

const mocks = vi.hoisted(() => ({
  fetchSettings: vi.fn(),
  fetchConfig: vi.fn(),
  updateSettings: vi.fn(),
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
  updateSettings: mocks.updateSettings,
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
    <CommandCenterControls
      projectId={projectId}
      colorTheme="default"
      themeMode="dark"
      onColorThemeChange={vi.fn()}
      onThemeModeChange={vi.fn()}
    />,
  );
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.appSettings.globalPaused = false;
  mocks.appSettings.enginePaused = false;
  mocks.fetchSettings.mockResolvedValue({ maxConcurrent: 2, maxTriageConcurrent: 2, maxWorktrees: 4 });
  mocks.fetchConfig.mockResolvedValue({ maxConcurrent: 2, rootDir: "/repo" });
  mocks.updateSettings.mockResolvedValue({});
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

  it("persists bounded concurrency slider changes and refreshes settings", async () => {
    renderControls("project-a");

    await flushPromises();
    const section = screen.getByTestId("cc-controls-concurrency");
    const slider = within(section).getByLabelText(/max concurrent tasks/i);
    fireEvent.change(slider, { target: { value: "7" } });

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    expect(mocks.updateSettings).toHaveBeenCalledWith(
      { maxConcurrent: 7, maxTriageConcurrent: 2, maxWorktrees: 4 },
      "project-a",
    );
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("persists concurrency slider changes at the default maximum of 50", async () => {
    renderControls("project-a");

    await flushPromises();
    const section = screen.getByTestId("cc-controls-concurrency");
    const slider = within(section).getByLabelText(/max concurrent tasks/i);
    fireEvent.change(slider, { target: { value: "50" } });

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    expect(mocks.updateSettings).toHaveBeenCalledWith(
      { maxConcurrent: 50, maxTriageConcurrent: 2, maxWorktrees: 4 },
      "project-a",
    );
  });

  it("persists concurrency slider changes without a project id", async () => {
    renderControls(undefined);

    await flushPromises();
    const section = screen.getByTestId("cc-controls-concurrency");
    const slider = within(section).getByLabelText(/max worktrees/i);
    fireEvent.change(slider, { target: { value: "12" } });

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    expect(mocks.updateSettings).toHaveBeenCalledWith(
      { maxConcurrent: 2, maxTriageConcurrent: 2, maxWorktrees: 12 },
      undefined,
    );
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
      within(section).getByLabelText(/max concurrent tasks/i),
      within(section).getByLabelText(/max triage concurrent/i),
      within(section).getByLabelText(/max worktrees/i),
    ];

    for (const slider of sliders) {
      expect(slider).toHaveClass("cc-controls-touch-slider");
    }
    // jsdom cannot simulate whether a touch drag is captured by page scrolling, so this verifies the CSS contract that enables horizontal thumb drags on mobile.
    expect(commandCenterControlsCss).toContain("touch-action: pan-y");
    expect(commandCenterControlsCss).toContain("@media (max-width: 768px)");
    expect(commandCenterControlsCss).toContain("min-block-size: var(--space-2xl)");
  });

  it("shows save error indicator when concurrency update fails", async () => {
    mocks.updateSettings.mockRejectedValueOnce(new Error("network error"));
    renderControls("project-a");

    await flushPromises();
    const section = screen.getByTestId("cc-controls-concurrency");
    const slider = within(section).getByLabelText(/max concurrent tasks/i);
    fireEvent.change(slider, { target: { value: "8" } });

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

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
    fireEvent.click(screen.getByRole("button", { name: /default/i }));
    fireEvent.click(screen.getAllByRole("option").find((element) => element.textContent?.trim() === "Forest")!);

    expect(onColorThemeChange).toHaveBeenCalledWith("forest");
  });
});
