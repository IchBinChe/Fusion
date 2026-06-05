import "./executor-test-helpers.js";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
// node:fs is mocked by executor-test-helpers; use node:fs/promises (unmocked) for
// real temp-dir + hook-script I/O.
import { mkdtemp, rm } from "node:fs/promises";
import { Database, CliSessionStore } from "@fusion/core";
import type { IPty } from "node-pty";
import { TaskExecutor, type CliAgentRuntime } from "../executor.js";
import { resetExecutorMocks } from "./executor-test-helpers.js";
import { CliSessionManager } from "../cli-agent/session-manager.js";
import { TelemetryHub } from "../cli-agent/telemetry-hub.js";
import { CliAdapterRegistry, type CliAgentAdapter } from "../cli-agent/adapter.js";

type Listener = (...args: any[]) => void;

// ── Mock PTY ────────────────────────────────────────────────────────────────

interface MockPty extends IPty {
  written: string[];
  killed: boolean;
  killSignal: string | undefined;
  emitData(data: string): void;
  emitExit(exitCode: number, signal?: number): void;
}
interface MockState {
  ptys: MockPty[];
}
function makeMockPtyModule(state: MockState): typeof import("node-pty") {
  return {
    spawn() {
      let dataCb: ((d: string) => void) | undefined;
      let exitCb: ((e: { exitCode: number; signal?: number }) => void) | undefined;
      const mock: MockPty = {
        pid: 3000 + state.ptys.length,
        cols: 80,
        rows: 24,
        process: "mock",
        handleFlowControl: false,
        written: [],
        killed: false,
        killSignal: undefined,
        onData: (cb: (d: string) => void) => {
          dataCb = cb;
          return { dispose() {} };
        },
        onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => {
          exitCb = cb;
          return { dispose() {} };
        },
        on() {},
        write(data: string) {
          mock.written.push(data);
        },
        resize() {},
        clear() {},
        kill(signal?: string) {
          mock.killed = true;
          mock.killSignal = signal;
          exitCb?.({ exitCode: 0, signal: signal === "SIGKILL" ? 9 : undefined });
        },
        pause() {},
        resume() {},
        emitData(d: string) {
          dataCb?.(d);
        },
        emitExit(exitCode: number, signal?: number) {
          exitCb?.({ exitCode, signal });
        },
      } as any;
      state.ptys.push(mock);
      return mock as unknown as IPty;
    },
  } as unknown as typeof import("node-pty");
}

function scriptedAdapter(): CliAgentAdapter {
  return {
    id: "scripted",
    name: "Scripted",
    capabilities: { nativeDone: true, nativeWaiting: true, transcriptSource: "hooks", supportsResume: true },
    buildLaunch: () => ({ command: "scripted", args: [] }),
    buildEnvAllowlist: () => ["PATH"],
    createReadinessDetector: () => {
      let ready = false;
      return {
        observe(chunk: string) {
          if (chunk.includes("READY")) ready = true;
          return ready;
        },
      };
    },
    formatInjection: (text) => ({ payload: text.endsWith("\r") ? text : `${text}\r` }),
  };
}

// ── Store stub satisfying the runGraphCustomNode/cli-agent code paths ──────────

function createStore(task: any) {
  const listeners = new Map<string, Set<Listener>>();
  const logs: string[] = [];
  return {
    logs,
    store: {
      on: vi.fn((event: string, listener: Listener) => {
        const set = listeners.get(event) ?? new Set<Listener>();
        set.add(listener);
        listeners.set(event, set);
      }),
      off: vi.fn(),
      getTask: vi.fn().mockImplementation(async () => task),
      logEntry: vi.fn().mockImplementation(async (_id: string, msg: string) => {
        logs.push(msg);
      }),
      updateTask: vi.fn().mockResolvedValue(undefined),
      getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false }),
      listTasks: vi.fn().mockResolvedValue([]),
    } as any,
  };
}

describe("cli-agent executor seam (U7)", () => {
  let tmpDir: string;
  let fusionDir: string;
  let db: Database;
  let cliStore: CliSessionStore;
  let registry: CliAdapterRegistry;
  let manager: CliSessionManager;
  let hub: TelemetryHub;
  let state: MockState;
  let worktree: string;

  beforeEach(async () => {
    resetExecutorMocks();
    vi.clearAllMocks();
    tmpDir = await mkdtemp(join(tmpdir(), "kb-cli-exec-"));
    fusionDir = join(tmpDir, ".fusion");
    worktree = join(tmpDir, "wt");
    db = new Database(fusionDir, { inMemory: true });
    db.init();
    cliStore = new CliSessionStore(fusionDir, db);
    registry = new CliAdapterRegistry();
    registry.register(scriptedAdapter());
    state = { ptys: [] };
    manager = new CliSessionManager({ registry, store: cliStore, loadPty: async () => makeMockPtyModule(state) });
    hub = new TelemetryHub({ store: cliStore });
  });

  afterEach(async () => {
    manager.dispose();
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function runtime(): CliAgentRuntime {
    return {
      manager,
      hub,
      registry,
      store: cliStore,
      projectId: "proj",
      hookEndpointUrl: "http://127.0.0.1:4040/api/cli-agent/hooks",
      hookDirRoot: tmpDir,
    };
  }

  function makeExecutor(task: any) {
    const { store, logs } = createStore(task);
    const executor = new TaskExecutor(store, tmpDir, { cliAgentRuntime: runtime() });
    return { executor, store, logs };
  }

  const cliNode = {
    id: "execute",
    kind: "prompt" as const,
    config: { executor: "cli-agent", cliAdapterId: "scripted", prompt: "implement the feature" },
  };

  const taskDetail = () => ({
    id: "FN-100",
    column: "in-progress",
    worktree,
    prompt: "implement the feature",
    steps: [],
    currentStep: 0,
  });

  function lastPty() {
    return state.ptys[state.ptys.length - 1];
  }

  // ── AE1 / F1 ────────────────────────────────────────────────────────────────

  it("AE1: cli-agent node spawns in worktree, injects prompt after readiness, native done advances, PTY reaped", async () => {
    const { executor } = makeExecutor(taskDetail());
    const resultP = (executor as any).runGraphCustomNode(cliNode, taskDetail(), {});

    // Wait for spawn.
    await vi.waitFor(() => expect(state.ptys).toHaveLength(1));

    // Readiness → injection.
    lastPty().emitData("READY\r\n");
    await vi.waitFor(() => expect(lastPty().written.some((w) => w.includes("implement the feature"))).toBe(true));

    // Resolve the live session via the hub (the registered session id).
    const sessions = cliStore.listByTask("FN-100");
    expect(sessions).toHaveLength(1);
    const sid = sessions[0].id;
    // Injection drives ready→busy on the machine asynchronously; wait for busy.
    await vi.waitFor(() => expect(hub.getStateMachine(sid)?.getState()).toBe("busy"));
    hub.ingest(sid, { kind: "done" });

    const result = await resultP;
    expect(result.outcome).toBe("success");
    expect(result.value).toBe("cli-agent-done");
    // Reaped at handoff.
    expect(lastPty().killed).toBe(true);
    expect(manager.isLive(sid)).toBe(false);
    expect(cliStore.getSession(sid)?.terminationReason).toBe("completed");
  });

  // ── AE5 ──────────────────────────────────────────────────────────────────────

  it("AE5: user input mid-busy doesn't break tracking; subsequent done still advances", async () => {
    const { executor } = makeExecutor(taskDetail());
    const resultP = (executor as any).runGraphCustomNode(cliNode, taskDetail(), {});
    await vi.waitFor(() => expect(state.ptys).toHaveLength(1));
    lastPty().emitData("READY\r\n");

    const sid = await vi.waitFor(() => {
      const s = cliStore.listByTask("FN-100");
      expect(s).toHaveLength(1);
      return s[0].id;
    });
    // The injection drives the ready→busy machine transition asynchronously;
    // wait until the machine has reached busy before exercising mid-busy input.
    await vi.waitFor(() => expect(hub.getStateMachine(sid)?.getState()).toBe("busy"));
    hub.ingest(sid, { kind: "sessionStart" });
    hub.ingest(sid, { kind: "busy" });
    // Mid-busy user keystrokes via the manager (deliberate control input).
    manager.write(sid, "hint\r");
    hub.ingest(sid, { kind: "toolActivity" });
    expect(hub.getStateMachine(sid)?.getState()).toBe("busy");

    hub.ingest(sid, { kind: "done" });
    const result = await resultP;
    expect(result.outcome).toBe("success");
  });

  // ── Hard cancel via the abort path ────────────────────────────────────────────

  it("hard cancel: abort path SIGKILLs the cli session, marks killed (not resume-eligible), releases slot", async () => {
    const { executor } = makeExecutor(taskDetail());
    const resultP = (executor as any).runGraphCustomNode(cliNode, taskDetail(), {});
    await vi.waitFor(() => expect(state.ptys).toHaveLength(1));
    lastPty().emitData("READY\r\n");
    const sid = await vi.waitFor(() => {
      const s = cliStore.listByTask("FN-100");
      expect(s).toHaveLength(1);
      return s[0].id;
    });
    hub.ingest(sid, { kind: "sessionStart" });
    hub.ingest(sid, { kind: "busy" });

    // The cli session is registered as an active surface.
    expect((executor as any).activeCliTaskSessions.has("FN-100")).toBe(true);
    expect(manager.activeCount()).toBe(1);

    // moveTask(in-progress→todo) hard cancel routes here.
    await executor.awaitAbortInFlightTaskWork("FN-100", "parent moved from in-progress to todo", {
      userCanceled: true,
    });

    const result = await resultP;
    expect(result.outcome).toBe("failure");
    expect(result.value).toBe("cli-agent-killed");
    expect(lastPty().killed).toBe(true);
    expect(lastPty().killSignal).toBe("SIGKILL");
    expect(manager.activeCount()).toBe(0);
    expect((executor as any).activeCliTaskSessions.has("FN-100")).toBe(false);
    expect(cliStore.getSession(sid)?.terminationReason).toBe("killed");
  });

  // ── Re-entry launches fresh (prior live session killed) ──────────────────────

  it("re-entry: a fresh run kills the prior live session and spawns a new PTY", async () => {
    const { executor } = makeExecutor(taskDetail());
    // First run, left live (no done).
    void (executor as any).runGraphCustomNode(cliNode, taskDetail(), {});
    await vi.waitFor(() => expect(state.ptys).toHaveLength(1));
    lastPty().emitData("READY\r\n");
    const firstId = await vi.waitFor(() => {
      const s = cliStore.listByTask("FN-100");
      expect(s.length).toBeGreaterThanOrEqual(1);
      return s[0].id;
    });
    expect(manager.isLive(firstId)).toBe(true);
    // Let the first run's async injection settle (it drives the machine to busy
    // and would otherwise overwrite the killed reason mid-race).
    await vi.waitFor(() => expect(hub.getStateMachine(firstId)?.getState()).toBe("busy"));
    // Drop the first run's active handle to simulate a graph re-entry without abort.
    (executor as any).activeCliTaskSessions.delete("FN-100");

    // Second run (RETHINK re-entry) — kills the prior live session, spawns fresh.
    const secondP = (executor as any).runGraphCustomNode(cliNode, taskDetail(), {});
    await vi.waitFor(() => expect(state.ptys).toHaveLength(2));
    expect(manager.isLive(firstId)).toBe(false);
    expect(cliStore.getSession(firstId)?.terminationReason).toBe("killed");

    lastPty().emitData("READY\r\n");
    const second = cliStore.listByTask("FN-100").find((s) => s.id !== firstId)!;
    await vi.waitFor(() => expect(hub.getStateMachine(second.id)?.getState()).toBe("busy"));
    hub.ingest(second.id, { kind: "done" });
    const result = await secondP;
    expect(result.outcome).toBe("success");
  });

  // ── Ceiling produces a typed surfaced value, not a hang ──────────────────────

  it("ceiling: spawn at the PTY pool ceiling produces a surfaced cli-agent-at-capacity value", async () => {
    const limited = new CliSessionManager({
      registry,
      store: cliStore,
      concurrencyCeiling: 1,
      loadPty: async () => makeMockPtyModule(state),
    });
    try {
      // Consume the only slot with a directly-spawned session.
      await limited.spawn({ adapterId: "scripted", projectId: "proj", purpose: "execute", worktreePath: worktree });
      const { store, logs } = createStore(taskDetail());
      const executor = new TaskExecutor(store, tmpDir, {
        cliAgentRuntime: { ...runtime(), manager: limited },
      });
      const result = await (executor as any).runGraphCustomNode(cliNode, taskDetail(), {});
      expect(result.outcome).toBe("failure");
      expect(result.value).toBe("cli-agent-at-capacity");
      expect(logs.some((l) => l.includes("ceiling"))).toBe(true);
    } finally {
      limited.dispose();
    }
  });

  // ── Missing config / runtime surface as clear errors ─────────────────────────

  it("missing cliAdapterId surfaces a clear config error (not a stall)", async () => {
    const { executor } = makeExecutor(taskDetail());
    const node = { id: "x", kind: "prompt" as const, config: { executor: "cli-agent", prompt: "go" } };
    const result = await (executor as any).runGraphCustomNode(node, taskDetail(), {});
    expect(result.outcome).toBe("failure");
    expect(result.value).toBe("cli-agent-adapter-missing");
  });

  it("absent runtime surfaces cli-agent-runtime-unavailable", async () => {
    const { store } = createStore(taskDetail());
    const executor = new TaskExecutor(store, tmpDir, {}); // no cliAgentRuntime
    const result = await (executor as any).runGraphCustomNode(cliNode, taskDetail(), {});
    expect(result.outcome).toBe("failure");
    expect(result.value).toBe("cli-agent-runtime-unavailable");
  });

  it("no worktree surfaces no-worktree-for-write-node", async () => {
    const noWt = { ...taskDetail(), worktree: undefined };
    const { store } = createStore(noWt);
    const executor = new TaskExecutor(store, tmpDir, { cliAgentRuntime: runtime() });
    const result = await (executor as any).runGraphCustomNode(cliNode, noWt, {});
    expect(result.outcome).toBe("failure");
    expect(result.value).toBe("no-worktree-for-write-node");
  });

  // ── Node-config edit mid-run keeps the launch-time snapshot ───────────────────

  it("node-config edit mid-run does not re-spawn or change the live session", async () => {
    const { executor } = makeExecutor(taskDetail());
    const node = {
      id: "execute",
      kind: "prompt" as const,
      config: { executor: "cli-agent", cliAdapterId: "scripted", prompt: "v1 prompt" },
    };
    const resultP = (executor as any).runGraphCustomNode(node, taskDetail(), {});
    await vi.waitFor(() => expect(state.ptys).toHaveLength(1));
    lastPty().emitData("READY\r\n");
    await vi.waitFor(() => expect(lastPty().written.some((w) => w.includes("v1 prompt"))).toBe(true));

    // Edit the node config object mid-run.
    node.config.prompt = "v2 prompt";
    const sid = cliStore.listByTask("FN-100")[0].id;
    await vi.waitFor(() => expect(hub.getStateMachine(sid)?.getState()).toBe("busy"));
    hub.ingest(sid, { kind: "done" });
    await resultP;

    // Exactly one PTY, and it only ever saw the launch-time prompt (no re-spawn).
    expect(state.ptys).toHaveLength(1);
    expect(lastPty().written.some((w) => w.includes("v2 prompt"))).toBe(false);
  });
});
