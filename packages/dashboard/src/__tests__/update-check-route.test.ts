// @vitest-environment node

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it, expect, vi, afterEach } from "vitest";
import type { TaskStore } from "@fusion/core";
import { createServer } from "../server.js";
import { get as performGet, request as performRequest } from "../test-request.js";

const updateCheckMocks = vi.hoisted(() => ({
  performUpdateCheck: vi.fn(),
  performUpdateInstall: vi.fn(),
  cliPackageImportMetaUrl: undefined as string | undefined,
}));

vi.mock("../update-check.js", async () => {
  const actual = await vi.importActual<typeof import("../update-check.js")>("../update-check.js");
  return {
    ...actual,
    performUpdateCheck: updateCheckMocks.performUpdateCheck,
    performUpdateInstall: updateCheckMocks.performUpdateInstall,
  };
});

vi.mock("../cli-package-version.js", async () => {
  const actual = await vi.importActual<typeof import("../cli-package-version.js")>("../cli-package-version.js");
  return {
    ...actual,
    getCliPackageVersion: (importMetaUrl?: string) => actual.getCliPackageVersion(updateCheckMocks.cliPackageImportMetaUrl ?? importMetaUrl),
  };
});

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    resolveGlobalDir: () => "/tmp/fusion-update-check-route-test",
  };
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PACKAGE_VERSION = (() => {
  const packageJsonPath = join(__dirname, "..", "..", "..", "cli", "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
    version?: unknown;
  };

  return typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
})();

function createMockStore(overrides: Partial<TaskStore> = {}): TaskStore {
  return {
    getTask: vi.fn(),
    listTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(),
    moveTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    mergeTask: vi.fn(),
    archiveTask: vi.fn(),
    unarchiveTask: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({}),
    updateSettings: vi.fn(),
    getGlobalSettingsStore: vi.fn().mockReturnValue({
      getSettings: vi.fn().mockResolvedValue({ updateCheckEnabled: true, updateCheckFrequency: "daily" }),
    }),
    logEntry: vi.fn().mockResolvedValue(undefined),
    getAgentLogs: vi.fn().mockResolvedValue([]),
    addSteeringComment: vi.fn(),
    updatePrInfo: vi.fn().mockResolvedValue(undefined),
    updateIssueInfo: vi.fn().mockResolvedValue(undefined),
    getRootDir: vi.fn().mockReturnValue("/fake/root"),
    getFusionDir: vi.fn().mockReturnValue("/fake/root/.fusion"),
    getDatabase: vi.fn().mockReturnValue({
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({ run: vi.fn().mockReturnValue({ changes: 0 }), get: vi.fn(), all: vi.fn().mockReturnValue([]) }),
    }),
    getMissionStore: vi.fn().mockReturnValue({
      listMissions: vi.fn().mockReturnValue([]),
      createMission: vi.fn(),
      getMissionWithHierarchy: vi.fn(),
      updateMission: vi.fn(),
      getMission: vi.fn(),
      deleteMission: vi.fn(),
      listMilestonesByMission: vi.fn().mockReturnValue([]),
      createMilestone: vi.fn(),
      updateMilestone: vi.fn(),
      getMilestone: vi.fn(),
      deleteMilestone: vi.fn(),
      listTasksByMilestone: vi.fn().mockReturnValue([]),
      createMissionTask: vi.fn(),
      updateMissionTask: vi.fn(),
      getMissionTask: vi.fn(),
      deleteMissionTask: vi.fn(),
    }),
    on: vi.fn(),
    off: vi.fn(),
    ...overrides,
  } as unknown as TaskStore;
}

function writePackageJson(dir: string, manifest: { name: string; version?: string }): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest, null, 2), "utf-8");
}

afterEach(() => {
  updateCheckMocks.performUpdateCheck.mockReset();
  updateCheckMocks.performUpdateInstall.mockReset();
  updateCheckMocks.cliPackageImportMetaUrl = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});


describe("GET /api/update-check", () => {
  it("announces a newly published release through the dashboard route", async () => {
    /*
     * FNXC:UpdateNotifications 2026-07-09-00:00:
     * The dashboard banner consumes /update-check, so this route must pass a fresh npm-release result through unchanged instead of hiding it behind settings, cache, or route shaping.
     */
    updateCheckMocks.performUpdateCheck.mockResolvedValueOnce({
      currentVersion: CLI_PACKAGE_VERSION,
      latestVersion: "99.0.0",
      updateAvailable: true,
      lastChecked: 123,
    });

    const app = createServer(createMockStore());
    const response = await performGet(app, "/api/update-check");

    expect(response.status).toBe(200);
    expect(updateCheckMocks.performUpdateCheck).toHaveBeenCalledWith(expect.any(String), CLI_PACKAGE_VERSION, {
      frequency: "daily",
    });
    expect(response.body).toEqual({
      currentVersion: CLI_PACKAGE_VERSION,
      latestVersion: "99.0.0",
      updateAvailable: true,
      lastChecked: 123,
    });
  });

  it("does not announce updates when update checks are disabled", async () => {
    const store = createMockStore({
      getGlobalSettingsStore: vi.fn().mockReturnValue({
        getSettings: vi.fn().mockResolvedValue({ updateCheckEnabled: false }),
      }),
    } as Partial<TaskStore>);

    const app = createServer(store);
    const response = await performGet(app, "/api/update-check");

    expect(response.status).toBe(200);
    expect(updateCheckMocks.performUpdateCheck).not.toHaveBeenCalled();
    expect(response.body).toMatchObject({
      currentVersion: CLI_PACKAGE_VERSION,
      latestVersion: null,
      updateAvailable: false,
      disabled: true,
    });
  });

  it("forces refresh so manual cadence can still check for a new release", async () => {
    updateCheckMocks.performUpdateCheck.mockResolvedValueOnce({
      currentVersion: CLI_PACKAGE_VERSION,
      latestVersion: "99.0.0",
      updateAvailable: true,
      lastChecked: 456,
    });

    const app = createServer(createMockStore());
    const response = await performRequest(app, "POST", "/api/update-check/refresh");

    expect(response.status).toBe(200);
    expect(updateCheckMocks.performUpdateCheck).toHaveBeenCalledWith(expect.any(String), CLI_PACKAGE_VERSION, {
      force: true,
    });
    expect(response.body.updateAvailable).toBe(true);
  });
});

describe("POST /api/update-check/install", () => {
  it("installs when a newer version is available", async () => {
    updateCheckMocks.performUpdateCheck.mockResolvedValueOnce({
      currentVersion: CLI_PACKAGE_VERSION,
      latestVersion: "99.0.0",
      updateAvailable: true,
      lastChecked: 123,
    });
    updateCheckMocks.performUpdateInstall.mockResolvedValueOnce({
      currentVersion: CLI_PACKAGE_VERSION,
      latestVersion: "99.0.0",
      updated: true,
    });

    const app = createServer(createMockStore());
    const response = await performRequest(app, "POST", "/api/update-check/install");

    expect(response.status).toBe(200);
    expect(updateCheckMocks.performUpdateCheck).toHaveBeenCalledWith(expect.any(String), CLI_PACKAGE_VERSION, {
      force: true,
    });
    expect(updateCheckMocks.performUpdateInstall).toHaveBeenCalledWith(CLI_PACKAGE_VERSION, "99.0.0", {
      fusionDir: expect.any(String),
    });
    expect(response.body).toEqual({
      currentVersion: CLI_PACKAGE_VERSION,
      latestVersion: "99.0.0",
      updated: true,
    });
  });

  it("returns updated=false without installing when already up to date", async () => {
    updateCheckMocks.performUpdateCheck.mockResolvedValueOnce({
      currentVersion: CLI_PACKAGE_VERSION,
      latestVersion: CLI_PACKAGE_VERSION,
      updateAvailable: false,
      lastChecked: 123,
    });

    const app = createServer(createMockStore());
    const response = await performRequest(app, "POST", "/api/update-check/install");

    expect(response.status).toBe(200);
    expect(updateCheckMocks.performUpdateInstall).not.toHaveBeenCalled();
    expect(response.body).toEqual({
      currentVersion: CLI_PACKAGE_VERSION,
      latestVersion: CLI_PACKAGE_VERSION,
      updated: false,
    });
  });
});

describe("GET /api/updates/check", () => {
  it("returns updateAvailable=true when npm has a newer version", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: "99.0.0" }),
      }),
    );

    const app = createServer(createMockStore());
    const response = await performGet(app, "/api/updates/check");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      currentVersion: CLI_PACKAGE_VERSION,
      latestVersion: "99.0.0",
      updateAvailable: true,
    });
  });

  it("returns updateAvailable=false when already up to date", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: CLI_PACKAGE_VERSION }),
      }),
    );

    const app = createServer(createMockStore());
    const response = await performGet(app, "/api/updates/check");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      currentVersion: CLI_PACKAGE_VERSION,
      latestVersion: CLI_PACKAGE_VERSION,
      updateAvailable: false,
    });
  });

  it("returns updateAvailable=false for packaged desktop when registry latest matches desktop version", async () => {
    const root = mkdtempSync(join(tmpdir(), "fusion-update-route-desktop-"));
    try {
      const dashboardDist = join(root, "node_modules", "@fusion", "dashboard", "dist");
      writePackageJson(root, { name: "@fusion/desktop", version: "5.4.3" });
      writePackageJson(join(root, "node_modules", "@fusion", "dashboard"), { name: "@fusion/dashboard", version: "0.0.0" });
      mkdirSync(dashboardDist, { recursive: true });
      updateCheckMocks.cliPackageImportMetaUrl = pathToFileURL(join(dashboardDist, "server.js")).href;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ version: "5.4.3" }),
        }),
      );

      const app = createServer(createMockStore());
      const response = await performGet(app, "/api/updates/check");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        currentVersion: "5.4.3",
        latestVersion: "5.4.3",
        updateAvailable: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the current version is unresolved", async () => {
    const root = mkdtempSync(join(tmpdir(), "fusion-update-route-unresolved-"));
    try {
      const dashboardDist = join(root, "node_modules", "@fusion", "dashboard", "dist");
      writePackageJson(join(root, "node_modules", "@fusion", "dashboard"), { name: "@fusion/dashboard", version: "0.0.0" });
      mkdirSync(dashboardDist, { recursive: true });
      updateCheckMocks.cliPackageImportMetaUrl = pathToFileURL(join(dashboardDist, "server.js")).href;
      vi.stubEnv("npm_package_version", undefined);
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const app = createServer(createMockStore());
      const response = await performGet(app, "/api/updates/check");

      expect(response.status).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(response.body).toEqual({
        currentVersion: "0.0.0",
        latestVersion: null,
        updateAvailable: false,
        error: "Current Fusion version is unavailable",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("gracefully returns an error payload when npm registry is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const app = createServer(createMockStore());
    const response = await performGet(app, "/api/updates/check");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      currentVersion: CLI_PACKAGE_VERSION,
      latestVersion: null,
      updateAvailable: false,
      error: "Failed to check for updates",
    });
  });
});
