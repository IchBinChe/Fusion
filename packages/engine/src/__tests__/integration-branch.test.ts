import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execMock, execSyncMock } = vi.hoisted(() => ({
  execMock: vi.fn(),
  execSyncMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  exec: execMock,
  execSync: execSyncMock,
}));

import {
  __resetIntegrationBranchCacheForTests,
  INTEGRATION_BRANCH_FALLBACK,
  resolveIntegrationBranch,
  resolveIntegrationBranchSync,
} from "../integration-branch.js";

describe("integration-branch resolver", () => {
  beforeEach(() => {
    __resetIntegrationBranchCacheForTests();
    execMock.mockReset();
    execSyncMock.mockReset();
  });

  afterEach(() => {
    __resetIntegrationBranchCacheForTests();
    vi.restoreAllMocks();
  });

  it("integrationBranch override wins over baseBranch and origin/HEAD", async () => {
    const resolved = await resolveIntegrationBranch("/repo", { integrationBranch: " trunk ", baseBranch: "develop" } as any);

    expect(resolved).toBe("trunk");
    expect(execMock).not.toHaveBeenCalled();
  });

  it("baseBranch wins over origin/HEAD", async () => {
    const resolved = await resolveIntegrationBranch("/repo", { baseBranch: " develop " } as any);

    expect(resolved).toBe("develop");
    expect(execMock).not.toHaveBeenCalled();
  });

  it("strips refs/remotes/origin and origin prefixes", async () => {
    execMock.mockImplementationOnce((_command: string, _opts: object, cb: (error: Error | null, result: { stdout: string }) => void) => {
      cb(null, { stdout: "refs/remotes/origin/master\n" });
      return {};
    });
    execMock.mockImplementationOnce((_command: string, _opts: object, cb: (error: Error | null, result: { stdout: string }) => void) => {
      cb(null, { stdout: "origin/develop\n" });
      return {};
    });

    const first = await resolveIntegrationBranch("/repo-a", {} as any);
    const second = await resolveIntegrationBranch("/repo-b", {} as any);

    expect(first).toBe("master");
    expect(second).toBe("develop");
  });

  it("treats whitespace and empty settings as unset", async () => {
    execMock.mockImplementation((_command: string, _opts: object, cb: (error: Error | null, result: { stdout: string }) => void) => {
      cb(null, { stdout: "origin/master\n" });
      return {};
    });

    const resolved = await resolveIntegrationBranch("/repo", { integrationBranch: "   ", baseBranch: "" } as any);

    expect(resolved).toBe("master");
  });

  it("falls back to main and warns once per rootDir", async () => {
    execMock.mockImplementation((_command: string, _opts: object, cb: (error: Error | null, result: { stdout: string }) => void) => {
      cb(new Error("no symbolic ref"), { stdout: "" });
      return {};
    });
    const warn = vi.fn();

    const first = await resolveIntegrationBranch("/repo", undefined, { logger: { warn } });
    const second = await resolveIntegrationBranch("/repo", undefined, { logger: { warn } });

    expect(first).toBe(INTEGRATION_BRANCH_FALLBACK);
    expect(second).toBe(INTEGRATION_BRANCH_FALLBACK);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("sync and async variants match", async () => {
    execMock.mockImplementation((_command: string, _opts: object, cb: (error: Error | null, result: { stdout: string }) => void) => {
      cb(null, { stdout: "refs/remotes/origin/master\n" });
      return {};
    });
    execSyncMock.mockReturnValue("origin/master\n");

    const asyncResolved = await resolveIntegrationBranch("/repo", undefined);
    const syncResolved = resolveIntegrationBranchSync("/repo", undefined);

    expect(syncResolved).toEqual(asyncResolved);
    expect(syncResolved).toBe("master");
  });

  it("swallows git failures and does not throw", async () => {
    execMock.mockImplementation((_command: string, _opts: object, cb: (error: Error | null, result: { stdout: string }) => void) => {
      cb(new Error("git failed"), { stdout: "" });
      return {};
    });
    execSyncMock.mockImplementation(() => {
      throw new Error("git failed");
    });

    await expect(resolveIntegrationBranch("/repo", undefined)).resolves.toBe(INTEGRATION_BRANCH_FALLBACK);
    expect(() => resolveIntegrationBranchSync("/repo", undefined)).not.toThrow();
  });
});
