import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const appHandlers = new Map<string, (...args: unknown[]) => void>();
  const app = {
    whenReady: vi.fn(async () => undefined),
    getPath: vi.fn((name: string) => (name === "home" ? "/mock/home" : "/mock/other")),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      appHandlers.set(event, handler);
      return app;
    }),
    quit: vi.fn(),
  };

  const browserWindow = {
    on: vi.fn(),
    once: vi.fn(),
    loadURL: vi.fn(),
    loadFile: vi.fn(),
    isDestroyed: vi.fn(() => false),
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: 800, height: 600 })),
    isMaximized: vi.fn(() => false),
    hide: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    maximize: vi.fn(),
    webContents: { send: vi.fn() },
  };

  const BrowserWindow = vi.fn(function () {
    return browserWindow;
  });
  const Tray = vi.fn(function () {
    return { destroy: vi.fn() };
  });

  const localRuntimeManager = {
    startLocal: vi.fn(async () => ({ source: "embedded-local", state: "running", port: 4041 })),
    stopLocal: vi.fn(async () => ({ source: "none", state: "stopped" })),
    getStatus: vi.fn(() => ({ source: "none", state: "stopped" })),
    getServerPort: vi.fn(() => undefined),
  };

  const screen = {
    getAllDisplays: vi.fn(() => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }]),
  };

  const LocalRuntimeManager = vi.fn(function () {
    return localRuntimeManager;
  });

  return { app, appHandlers, BrowserWindow, Tray, browserWindow, localRuntimeManager, LocalRuntimeManager, screen };
});

vi.mock("electron", () => ({
  app: mocks.app,
  BrowserWindow: mocks.BrowserWindow,
  Tray: mocks.Tray,
  nativeImage: { createEmpty: vi.fn(() => ({})) },
  screen: mocks.screen,
}));

vi.mock("../renderer.js", () => ({ isUrlRenderer: vi.fn(() => true), getRendererUrl: vi.fn(() => "http://localhost"), getRendererFilePath: vi.fn(() => "index.html") }));
vi.mock("../menu.js", () => ({ buildAppMenu: vi.fn() }));
vi.mock("../tray.js", () => ({ setupTray: vi.fn() }));
vi.mock("../ipc.js", () => ({ registerIpcHandlers: vi.fn() }));
vi.mock("../native.js", () => ({
  DEFAULT_WINDOW_STATE: { width: 1000, height: 800 },
  loadWindowState: vi.fn(async () => null),
  loadDesktopLaunchMode: vi.fn(async () => "choose"),
  saveDesktopLaunchMode: vi.fn(async () => undefined),
  saveWindowState: vi.fn(),
  setupAutoUpdater: vi.fn(),
  startUpdateCheckInterval: vi.fn(() => vi.fn()),
  clampWindowStateToVisibleDisplay: vi.fn((state) => state),
}));
vi.mock("../deep-link.js", () => ({ registerDeepLinkProtocol: vi.fn(), setupDeepLinkHandler: vi.fn() }));
vi.mock("../local-runtime.js", () => ({ LocalRuntimeManager: mocks.LocalRuntimeManager }));

describe("main local mode", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.appHandlers.clear();
    delete process.env.FUSION_DESKTOP_MODE;
  });

  it("starts local runtime manager when FUSION_DESKTOP_MODE is local", async () => {
    process.env.FUSION_DESKTOP_MODE = "local";
    const { initializeApp } = await import("../main.ts");
    await initializeApp();

    expect(mocks.LocalRuntimeManager).toHaveBeenCalledWith({ rootDir: "/mock/home" });
    expect(mocks.app.getPath).toHaveBeenCalledWith("home");
    expect(mocks.localRuntimeManager.startLocal).toHaveBeenCalled();
    delete process.env.FUSION_DESKTOP_MODE;
  });
});
