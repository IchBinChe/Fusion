import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { Database } from "@fusion/core";
import type { IPty } from "node-pty";
import { createCliAgentRuntime, type BootstrappedCliAgentRuntime } from "../runtime.js";
import { BUNDLED_CLI_ADAPTERS } from "../adapters/index.js";

// ── Mock PTY at the loadPtyModule seam (runtime construction must not touch a
// real PTY; spawning is not exercised here). ───────────────────────────────────

function makeMockPtyModule(): typeof import("node-pty") {
  return {
    spawn() {
      const mock = {
        pid: 4242,
        cols: 80,
        rows: 24,
        process: "mock",
        handleFlowControl: false,
        onData: () => ({ dispose: () => {} }),
        onExit: () => ({ dispose: () => {} }),
        write: () => {},
        resize: () => {},
        pause: () => {},
        resume: () => {},
        kill: () => {},
        clear: () => {},
      };
      return mock as unknown as IPty;
    },
  } as unknown as typeof import("node-pty");
}

interface Harness {
  runtime: BootstrappedCliAgentRuntime;
  db: Database;
  tmpDir: string;
  fusionDir: string;
}

function makeHarness(): Harness {
  const tmpDir = mkdtempSync(join(tmpdir(), "fn-cli-runtime-test-"));
  const fusionDir = join(tmpDir, ".fusion");
  const db = new Database(fusionDir, { inMemory: true });
  db.init();
  const runtime = createCliAgentRuntime({
    fusionDir,
    db,
    projectId: "proj-1",
    hookEndpointUrl: "http://127.0.0.1:4040/api/cli-agent/hooks",
    managerOptions: { loadPty: async () => makeMockPtyModule() },
  });
  return { runtime, db, tmpDir, fusionDir };
}

describe("createCliAgentRuntime", () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(async () => {
    h.runtime.dispose();
    h.db.close();
    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it("constructs the full bundle with manager, hub, registry, and store", () => {
    const { bundle } = h.runtime;
    expect(bundle.manager).toBeDefined();
    expect(bundle.hub).toBeDefined();
    expect(bundle.registry).toBeDefined();
    expect(bundle.store).toBeDefined();
    expect(bundle.projectId).toBe("proj-1");
    expect(bundle.hookEndpointUrl).toBe("http://127.0.0.1:4040/api/cli-agent/hooks");
  });

  it("registers all bundled adapters into a per-runtime registry", () => {
    const ids = h.runtime.bundle.registry.ids().sort();
    const expected = BUNDLED_CLI_ADAPTERS.map((a) => a.id).sort();
    expect(ids).toEqual(expected);
    expect(ids).toHaveLength(5);
  });

  it("does not pollute a second runtime's registry (no duplicate-registration)", () => {
    // A second runtime over the SAME process registers the same adapters again;
    // a per-runtime registry means no DuplicateCliAdapterError is thrown.
    const second = createCliAgentRuntime({
      fusionDir: h.fusionDir,
      db: h.db,
      projectId: "proj-2",
      hookEndpointUrl: "http://127.0.0.1:4040/api/cli-agent/hooks",
      managerOptions: { loadPty: async () => makeMockPtyModule() },
    });
    expect(second.bundle.registry.ids()).toHaveLength(5);
    second.dispose();
  });

  it("isWorktreeResumeReserved reflects resume-eligible session records", () => {
    const adapterId = BUNDLED_CLI_ADAPTERS[0].id;
    // A live-on-restart record (busy) reserves its worktree.
    h.runtime.bundle.store.createSession({
      adapterId,
      projectId: "proj-1",
      purpose: "execute",
      taskId: "FN-1",
      worktreePath: "/wt/reserved",
      agentState: "busy",
    });
    expect(h.runtime.isWorktreeResumeReserved("/wt/reserved")).toBe(true);
    expect(h.runtime.isWorktreeResumeReserved("/wt/other")).toBe(false);
  });

  it("isCliSessionWaitingOnInput is true only when a task's session is waitingOnInput", () => {
    const adapterId = BUNDLED_CLI_ADAPTERS[0].id;
    h.runtime.bundle.store.createSession({
      adapterId,
      projectId: "proj-1",
      purpose: "execute",
      taskId: "FN-busy",
      worktreePath: "/wt/busy",
      agentState: "busy",
    });
    h.runtime.bundle.store.createSession({
      adapterId,
      projectId: "proj-1",
      purpose: "execute",
      taskId: "FN-wait",
      worktreePath: "/wt/wait",
      agentState: "waitingOnInput",
    });
    expect(h.runtime.isCliSessionWaitingOnInput("FN-wait")).toBe(true);
    expect(h.runtime.isCliSessionWaitingOnInput("FN-busy")).toBe(false);
    expect(h.runtime.isCliSessionWaitingOnInput("FN-unknown")).toBe(false);
  });

  it("exposes a resume coordinator whose recoverOnStart runs cleanly with no orphans", async () => {
    const results = await h.runtime.resumeCoordinator.recoverOnStart();
    expect(Array.isArray(results)).toBe(true);
    expect(results).toHaveLength(0);
  });

  it("dispose tears down the manager without throwing and is idempotent", () => {
    expect(() => h.runtime.dispose()).not.toThrow();
    expect(() => h.runtime.dispose()).not.toThrow();
    // Re-dispose in afterEach is also safe.
  });
});
