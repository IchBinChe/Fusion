import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// t() returns the provided fallback so we assert on stable English text.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}));

const getShellHostContext = vi.fn();
vi.mock("../../shell-host", () => ({ getShellHostContext: () => getShellHostContext() }));

import { DesktopLaunchGate } from "../DesktopLaunchGate";

type LocationStub = { href: string; search: string; replace: ReturnType<typeof vi.fn>; reload: ReturnType<typeof vi.fn> };

function stubLocation(search: string): LocationStub {
  const loc: LocationStub = {
    href: `file:///C:/app/index.html${search}`,
    search,
    replace: vi.fn(),
    reload: vi.fn(),
  };
  Object.defineProperty(window, "location", { value: loc, writable: true, configurable: true });
  return loc;
}

function stubShell(state: unknown) {
  const shell = {
    getState: vi.fn(async () => state),
    setDesktopMode: vi.fn(async () => state),
    onResetDesktopModeRequest: vi.fn(() => () => undefined),
    resetDesktopMode: vi.fn(async () => undefined),
  };
  (window as unknown as { fusionShell: unknown }).fusionShell = shell;
  return shell;
}

describe("DesktopLaunchGate — local handoff", () => {
  beforeEach(() => {
    getShellHostContext.mockReset();
  });
  afterEach(() => {
    delete (window as unknown as { fusionShell?: unknown }).fusionShell;
  });

  /*
   * Regression: after applyServerBaseUrl() reloads with ?serverBaseUrl=…, main.tsx's
   * bootstrapShellHostContext() strips that param from the URL before this gate runs. The gate
   * MUST recognize the completed handoff from the cached shell-host context (serverUrl), not the
   * stripped URL — otherwise it re-triggers the handoff → window.location.replace → reload loop
   * ("rapid Starting local Fusion runtime flashing that never connects").
   */
  it("renders children (no reload) when the handoff is present in the cached context but stripped from the URL", async () => {
    const location = stubLocation(""); // URL already stripped by bootstrap
    getShellHostContext.mockReturnValue({ kind: "desktop-shell", mode: "local", serverUrl: "http://127.0.0.1:50123" });
    stubShell({
      host: "desktop-shell",
      desktopMode: "local",
      desktopModeState: { isFirstRun: false, desktopMode: "local" },
      localRuntime: { source: "embedded-local", state: "running", port: 50123, baseUrl: "http://127.0.0.1:50123" },
    });

    render(
      <DesktopLaunchGate>
        <div data-testid="app-loaded">app</div>
      </DesktopLaunchGate>,
    );

    await waitFor(() => expect(screen.getByTestId("app-loaded")).toBeTruthy());
    // The bug was an infinite reload; assert we never reload.
    expect(location.replace).not.toHaveBeenCalled();
  });

  it("performs the handoff exactly once on first load (no cached serverUrl yet)", async () => {
    const location = stubLocation(""); // fresh launch, no shell params
    getShellHostContext.mockReturnValue({ kind: "desktop-shell" }); // bootstrap saw no serverUrl
    stubShell({
      host: "desktop-shell",
      desktopMode: "local",
      desktopModeState: { isFirstRun: false, desktopMode: "local" },
      localRuntime: { source: "embedded-local", state: "running", port: 50123, baseUrl: "http://127.0.0.1:50123" },
    });

    render(
      <DesktopLaunchGate>
        <div data-testid="app-loaded">app</div>
      </DesktopLaunchGate>,
    );

    await waitFor(() => expect(location.replace).toHaveBeenCalledTimes(1));
    expect(location.replace.mock.calls[0][0]).toContain("serverBaseUrl=http%3A%2F%2F127.0.0.1%3A50123");
  });
});
