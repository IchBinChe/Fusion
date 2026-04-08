import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QuickScriptsDropdown } from "../QuickScriptsDropdown";
import { fetchScripts } from "../../api";

vi.mock("../../api", () => ({
  fetchScripts: vi.fn(),
}));

const onOpenScripts = vi.fn();
const onRunScript = vi.fn();

const MOCK_SCRIPTS = {
  build: "pnpm build",
  lint: "pnpm lint",
  test: "pnpm test",
};

describe("QuickScriptsDropdown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.mocked(fetchScripts).mockResolvedValue(MOCK_SCRIPTS);
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1280,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      writable: true,
      value: 900,
    });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      writable: true,
      value: undefined,
    });
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as MediaQueryList));
  });

  function renderDropdown() {
    render(
      <QuickScriptsDropdown
        onOpenScripts={onOpenScripts}
        onRunScript={onRunScript}
      />,
    );
  }

  function mockTriggerRect(rect: Partial<DOMRect>) {
    const trigger = screen.getByTestId("scripts-btn");
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: rect.left ?? 0,
      y: rect.top ?? 0,
      width: rect.width ?? 80,
      height: rect.height ?? 32,
      top: rect.top ?? 0,
      right: (rect.left ?? 0) + (rect.width ?? 80),
      bottom: (rect.top ?? 0) + (rect.height ?? 32),
      left: rect.left ?? 0,
      toJSON: () => ({}),
    });

    return trigger;
  }

  it("renders below trigger when space is available", async () => {
    const user = userEvent.setup();
    renderDropdown();
    const trigger = mockTriggerRect({ top: 120, left: 220, width: 120, height: 36 });

    await user.click(trigger);

    const dropdown = await screen.findByTestId("quick-scripts-dropdown");

    await waitFor(() => {
      expect(dropdown.style.position).toBe("fixed");
      expect(dropdown.style.top).toBe("162px");
      expect(dropdown.style.left).toBe("220px");
      expect(dropdown.style.width).toBe("260px");
    });
  });

  it("repositions above trigger when viewport bottom is near", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 375,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      writable: true,
      value: 667,
    });

    renderDropdown();
    const trigger = mockTriggerRect({ top: 560, left: 330, width: 120, height: 36 });

    await user.click(trigger);

    const dropdown = await screen.findByTestId("quick-scripts-dropdown");

    await waitFor(() => {
      expect(dropdown.style.top).toBe("274px");
      expect(dropdown.style.left).toBe("99px");
      expect(dropdown.style.width).toBe("260px");
    });
  });

  it("clamps horizontal position to viewport edges on small screens", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 360,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      writable: true,
      value: 700,
    });

    renderDropdown();
    const trigger = mockTriggerRect({ top: 140, left: -40, width: 120, height: 36 });

    await user.click(trigger);

    const dropdown = await screen.findByTestId("quick-scripts-dropdown");

    await waitFor(() => {
      expect(dropdown.style.left).toBe("16px");
    });
  });

  it("repositions on window resize", async () => {
    const user = userEvent.setup();
    renderDropdown();

    const triggerRect = { top: 120, left: 220, width: 120, height: 36 };
    const trigger = mockTriggerRect(triggerRect);

    await user.click(trigger);

    const dropdown = await screen.findByTestId("quick-scripts-dropdown");
    await waitFor(() => {
      expect(dropdown.style.top).toBe("162px");
    });

    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      writable: true,
      value: 360,
    });
    fireEvent(window, new Event("resize"));

    await waitFor(() => {
      expect(dropdown.style.top).toBe("64px");
    });
  });

  it("keeps keyboard navigation behavior (arrow keys, enter, escape)", async () => {
    const user = userEvent.setup();
    renderDropdown();
    const trigger = mockTriggerRect({ top: 120, left: 220, width: 120, height: 36 });

    await user.click(trigger);

    const dropdown = await screen.findByTestId("quick-scripts-dropdown");
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");

    expect(onRunScript).toHaveBeenCalledWith("build", "pnpm build");

    await user.click(trigger);
    await screen.findByTestId("quick-scripts-dropdown");
    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByTestId("quick-scripts-dropdown")).toBeNull();
    });

    expect(dropdown).toBeTruthy();
  });
});
