// @vitest-environment node

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dashboardRoot = join(__dirname, "..", "..");
const wrapperPath = join(dashboardRoot, "scripts", "run-vitest-with-heap.mjs");

const activeWrappers = new Set<ChildProcess>();
const tempDirs = new Set<string>();
const trackedGroupLeaders = new Set<number>();
const trackedPids = new Set<number>();

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

function registerPid(pid: number) {
  trackedPids.add(pid);
}

function registerGroupLeader(pid: number) {
  trackedGroupLeaders.add(pid);
  registerPid(pid);
}

function createStubProcessTree() {
  const tempDir = mkdtempSync(join(tmpdir(), "fusion-run-vitest-"));
  tempDirs.add(tempDir);

  const pidFile = join(tempDir, "pids.json");
  const grandchildPath = join(tempDir, "grandchild.mjs");
  const childPath = join(tempDir, "child.mjs");

  writeFileSync(
    grandchildPath,
    ['setInterval(() => {}, 1_000);'].join("\n"),
  );

  writeFileSync(
    childPath,
    [
      'import { writeFileSync } from "node:fs";',
      'import { spawn } from "node:child_process";',
      '',
      'const pidFile = process.argv[2];',
      'const grandchildPath = process.argv[3];',
      'const grandchild = spawn(process.execPath, [grandchildPath], { stdio: "ignore" });',
      'writeFileSync(pidFile, JSON.stringify({ childPid: process.pid, grandchildPid: grandchild.pid }));',
      'setInterval(() => {}, 1_000);',
    ].join("\n"),
  );

  return { pidFile, childPath, grandchildPath, tempDir };
}

async function spawnWrapperTree(signal: NodeJS.Signals) {
  const { pidFile, childPath, grandchildPath } = createStubProcessTree();
  const wrapper = spawn(
    process.execPath,
    [wrapperPath, "--heap=6144", "run", "--project", "dashboard-api-quality"],
    {
      cwd: dashboardRoot,
      stdio: "pipe",
      env: {
        ...process.env,
        FUSION_RUN_VITEST_SPAWN_OVERRIDE: JSON.stringify({
          command: process.execPath,
          args: [childPath, pidFile, grandchildPath],
        }),
      },
    },
  );
  activeWrappers.add(wrapper);

  let pids: { childPid: number; grandchildPid: number } | null = null;
  await waitFor(() => {
    try {
      pids = JSON.parse(readFileSync(pidFile, "utf8")) as { childPid: number; grandchildPid: number };
      return Boolean(
        pids &&
          Number.isInteger(pids.childPid) &&
          Number.isInteger(pids.grandchildPid) &&
          isProcessAlive(pids.childPid) &&
          isProcessAlive(pids.grandchildPid),
      );
    } catch {
      return false;
    }
  });

  registerGroupLeader(pids!.childPid);
  registerPid(pids!.grandchildPid);

  wrapper.kill(signal);
  await new Promise<void>((resolve, reject) => {
    wrapper.once("error", reject);
    wrapper.once("close", () => resolve());
  });
  activeWrappers.delete(wrapper);

  await waitFor(() => !isProcessAlive(pids!.childPid) && !isProcessAlive(pids!.grandchildPid));
}

afterEach(async () => {
  for (const wrapper of activeWrappers) {
    wrapper.kill("SIGKILL");
  }
  activeWrappers.clear();

  for (const leaderPid of trackedGroupLeaders) {
    try {
      process.kill(-leaderPid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") {
        throw error;
      }
    }
  }
  trackedGroupLeaders.clear();

  for (const pid of trackedPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") {
        throw error;
      }
    }
  }
  trackedPids.clear();

  for (const tempDir of tempDirs) {
    rmSync(tempDir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe("run-vitest-with-heap", () => {
  it("reaps the spawned process group on SIGTERM", async () => {
    await spawnWrapperTree("SIGTERM");
  });

  it("reaps the spawned process group on SIGINT", async () => {
    await spawnWrapperTree("SIGINT");
  });
});
