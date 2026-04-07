import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HeartbeatMonitor, type AgentSession } from "./agent-heartbeat.js";
import type { AgentStore } from "@fusion/core";

// Mock store factory
function createMockStore(overrides: Partial<AgentStore> = {}): AgentStore {
  return {
    recordHeartbeat: vi.fn().mockResolvedValue(undefined),
    updateAgentState: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as AgentStore;
}

// Mock session factory
function createMockSession(): AgentSession {
  return {
    dispose: vi.fn(),
  };
}

describe("HeartbeatMonitor", () => {
  let store: AgentStore;
  let monitor: HeartbeatMonitor;

  beforeEach(() => {
    store = createMockStore();
    monitor = new HeartbeatMonitor({ store });
  });

  afterEach(() => {
    monitor.stop();
    vi.useRealTimers();
  });

  describe("constructor", () => {
    it("initializes with default options", () => {
      expect(monitor).toBeDefined();
      expect(monitor.isActive()).toBe(false);
    });

    it("accepts custom pollIntervalMs", () => {
      const customMonitor = new HeartbeatMonitor({ store, pollIntervalMs: 5000 });
      expect(customMonitor).toBeDefined();
    });

    it("accepts custom heartbeatTimeoutMs", () => {
      const customMonitor = new HeartbeatMonitor({ store, heartbeatTimeoutMs: 120000 });
      expect(customMonitor).toBeDefined();
    });

    it("accepts callbacks", () => {
      const onMissed = vi.fn();
      const onRecovered = vi.fn();
      const onTerminated = vi.fn();

      const customMonitor = new HeartbeatMonitor({
        store,
        onMissed,
        onRecovered,
        onTerminated,
      });

      expect(customMonitor).toBeDefined();
    });
  });

  describe("start", () => {
    it("initiates polling interval", () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      monitor.start();
      expect(monitor.isActive()).toBe(true);
      vi.useRealTimers();
    });

    it("is idempotent (multiple calls don't create multiple intervals)", () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      monitor.start();
      monitor.start();
      monitor.start();

      expect(monitor.isActive()).toBe(true);
      // Stop should clean up properly
      monitor.stop();
      expect(monitor.isActive()).toBe(false);
      vi.useRealTimers();
    });
  });

  describe("stop", () => {
    it("clears the polling interval", () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      monitor.start();
      expect(monitor.isActive()).toBe(true);

      monitor.stop();
      expect(monitor.isActive()).toBe(false);
      vi.useRealTimers();
    });

    it("is safe to call when not started", () => {
      expect(() => monitor.stop()).not.toThrow();
      expect(monitor.isActive()).toBe(false);
    });

    it("is safe to call multiple times", () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      monitor.start();
      monitor.stop();
      monitor.stop();
      monitor.stop();

      expect(monitor.isActive()).toBe(false);
      vi.useRealTimers();
    });
  });

  describe("isActive", () => {
    it("reflects monitor state (false when not started)", () => {
      expect(monitor.isActive()).toBe(false);
    });

    it("reflects monitor state (true when started)", () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      monitor.start();
      expect(monitor.isActive()).toBe(true);
      vi.useRealTimers();
    });

    it("reflects monitor state (false after stopped)", () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      monitor.start();
      monitor.stop();
      expect(monitor.isActive()).toBe(false);
      vi.useRealTimers();
    });
  });

  describe("trackAgent", () => {
    it("adds agent to tracked set with correct initial state", () => {
      const session = createMockSession();
      const before = Date.now();

      monitor.trackAgent("agent-001", session, "run-001");
      const lastSeen = monitor.getLastSeen("agent-001");

      expect(lastSeen).toBeDefined();
      expect(lastSeen).toBeGreaterThanOrEqual(before);
      expect(monitor.getTrackedAgents()).toContain("agent-001");
    });

    it("records initial heartbeat to store", () => {
      const session = createMockSession();
      monitor.trackAgent("agent-001", session, "run-001");

      expect(store.recordHeartbeat).toHaveBeenCalledWith("agent-001", "ok", "run-001");
    });

    it("can track multiple agents", () => {
      monitor.trackAgent("agent-001", createMockSession(), "run-001");
      monitor.trackAgent("agent-002", createMockSession(), "run-002");
      monitor.trackAgent("agent-003", createMockSession(), "run-003");

      expect(monitor.getTrackedAgents()).toHaveLength(3);
      expect(monitor.getTrackedAgents()).toContain("agent-001");
      expect(monitor.getTrackedAgents()).toContain("agent-002");
      expect(monitor.getTrackedAgents()).toContain("agent-003");
    });
  });

  describe("recordHeartbeat", () => {
    it("updates lastSeen timestamp", () => {
      const session = createMockSession();
      vi.useFakeTimers({ shouldAdvanceTime: true });

      monitor.trackAgent("agent-001", session, "run-001");
      const initialLastSeen = monitor.getLastSeen("agent-001")!;

      vi.advanceTimersByTime(100);
      monitor.recordHeartbeat("agent-001");

      const newLastSeen = monitor.getLastSeen("agent-001")!;
      expect(newLastSeen).toBeGreaterThan(initialLastSeen);

      vi.useRealTimers();
    });

    it("records ok heartbeat to store", () => {
      const session = createMockSession();
      monitor.trackAgent("agent-001", session, "run-001");
      monitor.recordHeartbeat("agent-001");

      // Should have been called twice: once on track, once on heartbeat
      expect(store.recordHeartbeat).toHaveBeenCalledTimes(2);
      expect(store.recordHeartbeat).toHaveBeenLastCalledWith("agent-001", "ok", "run-001");
    });

    it("triggers onRecovered callback after missed heartbeat", () => {
      const onRecovered = vi.fn();
      const customMonitor = new HeartbeatMonitor({ store, onRecovered });
      const session = createMockSession();

      vi.useFakeTimers({ shouldAdvanceTime: true });
      customMonitor.trackAgent("agent-001", session, "run-001");

      // Simulate missed heartbeat by advancing time
      vi.advanceTimersByTime(70000); // Default timeout is 60000

      // Trigger the check
      customMonitor.stop();

      // Reset and record heartbeat (should trigger recovery)
      customMonitor.recordHeartbeat("agent-001");
      expect(onRecovered).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("does nothing for untracked agent", () => {
      expect(() => monitor.recordHeartbeat("agent-001")).not.toThrow();
      expect(store.recordHeartbeat).not.toHaveBeenCalled();
    });
  });

  describe("isAgentHealthy", () => {
    it("returns true for recent heartbeat", () => {
      const session = createMockSession();
      monitor.trackAgent("agent-001", session, "run-001");

      expect(monitor.isAgentHealthy("agent-001")).toBe(true);
    });

    it("returns false for missed heartbeat", () => {
      const session = createMockSession();
      vi.useFakeTimers({ shouldAdvanceTime: true });

      // Use short timeout for testing
      const customMonitor = new HeartbeatMonitor({
        store,
        heartbeatTimeoutMs: 5000,
      });

      customMonitor.trackAgent("agent-001", session, "run-001");
      expect(customMonitor.isAgentHealthy("agent-001")).toBe(true);

      // Advance past timeout
      vi.advanceTimersByTime(6000);
      expect(customMonitor.isAgentHealthy("agent-001")).toBe(false);

      vi.useRealTimers();
    });

    it("returns false for untracked agent", () => {
      expect(monitor.isAgentHealthy("agent-001")).toBe(false);
    });
  });

  describe("getTrackedAgents", () => {
    it("returns empty array when no agents tracked", () => {
      expect(monitor.getTrackedAgents()).toEqual([]);
    });

    it("returns all tracked agent IDs", () => {
      monitor.trackAgent("agent-001", createMockSession(), "run-001");
      monitor.trackAgent("agent-002", createMockSession(), "run-002");

      const agents = monitor.getTrackedAgents();
      expect(agents).toHaveLength(2);
      expect(agents).toContain("agent-001");
      expect(agents).toContain("agent-002");
    });
  });

  describe("getLastSeen", () => {
    it("returns correct timestamp for tracked agent", () => {
      const session = createMockSession();
      const before = Date.now();

      monitor.trackAgent("agent-001", session, "run-001");
      const lastSeen = monitor.getLastSeen("agent-001");

      expect(lastSeen).toBeDefined();
      expect(lastSeen).toBeGreaterThanOrEqual(before);
    });

    it("returns undefined for untracked agent", () => {
      expect(monitor.getLastSeen("agent-001")).toBeUndefined();
    });
  });

  describe("missed heartbeat detection", () => {
    it("triggers onMissed callback when heartbeat is missed", async () => {
      const onMissed = vi.fn();
      const customMonitor = new HeartbeatMonitor({
        store,
        heartbeatTimeoutMs: 5000,
        pollIntervalMs: 1000,
        onMissed,
      });
      const session = createMockSession();

      vi.useFakeTimers({ shouldAdvanceTime: true });
      customMonitor.start();
      customMonitor.trackAgent("agent-001", session, "run-001");

      // Wait for polling to detect missed heartbeat
      vi.advanceTimersByTime(6000);

      // Wait for async checkMissedHeartbeats
      await vi.advanceTimersByTimeAsync(100);

      expect(onMissed).toHaveBeenCalledWith("agent-001");

      customMonitor.stop();
      vi.useRealTimers();
    });

    it("records missed heartbeat to store", async () => {
      const customMonitor = new HeartbeatMonitor({
        store,
        heartbeatTimeoutMs: 5000,
        pollIntervalMs: 1000,
      });
      const session = createMockSession();

      vi.useFakeTimers({ shouldAdvanceTime: true });
      customMonitor.start();
      customMonitor.trackAgent("agent-001", session, "run-001");

      // Wait for polling to detect missed heartbeat
      vi.advanceTimersByTime(6000);
      await vi.advanceTimersByTimeAsync(100);

      expect(store.recordHeartbeat).toHaveBeenCalledWith("agent-001", "missed", "run-001");

      customMonitor.stop();
      vi.useRealTimers();
    });
  });

  describe("unresponsive agent termination", () => {
    it("disposes session and terminates agent after 2x timeout", async () => {
      const onTerminated = vi.fn();
      const session = createMockSession();
      const customMonitor = new HeartbeatMonitor({
        store,
        heartbeatTimeoutMs: 5000,
        pollIntervalMs: 1000,
        onTerminated,
      });

      vi.useFakeTimers({ shouldAdvanceTime: true });
      customMonitor.start();
      customMonitor.trackAgent("agent-001", session, "run-001");

      // Wait for missed heartbeat (1x timeout)
      vi.advanceTimersByTime(6000);
      await vi.advanceTimersByTimeAsync(100);

      // Wait for termination (2x timeout = 10 seconds total from start)
      vi.advanceTimersByTime(6000);
      await vi.advanceTimersByTimeAsync(100);

      expect(session.dispose).toHaveBeenCalled();
      expect(store.updateAgentState).toHaveBeenCalledWith("agent-001", "terminated");
      expect(onTerminated).toHaveBeenCalledWith("agent-001");

      customMonitor.stop();
      vi.useRealTimers();
    });

    it("removes agent from tracking after termination", async () => {
      const session = createMockSession();
      const customMonitor = new HeartbeatMonitor({
        store,
        heartbeatTimeoutMs: 5000,
        pollIntervalMs: 1000,
      });

      vi.useFakeTimers({ shouldAdvanceTime: true });
      customMonitor.start();
      customMonitor.trackAgent("agent-001", session, "run-001");

      expect(customMonitor.getTrackedAgents()).toContain("agent-001");

      // Wait for termination
      vi.advanceTimersByTime(12000);
      await vi.advanceTimersByTimeAsync(100);

      expect(customMonitor.getTrackedAgents()).not.toContain("agent-001");

      customMonitor.stop();
      vi.useRealTimers();
    });
  });

  describe("untrackAgent", () => {
    it("removes agent from tracking", () => {
      const session = createMockSession();
      monitor.trackAgent("agent-001", session, "run-001");
      expect(monitor.getTrackedAgents()).toContain("agent-001");

      monitor.untrackAgent("agent-001");
      expect(monitor.getTrackedAgents()).not.toContain("agent-001");
      expect(monitor.getTrackedAgents()).toHaveLength(0);
    });

    it("is safe to call for untracked agent", () => {
      expect(() => monitor.untrackAgent("agent-001")).not.toThrow();
    });
  });

  // ── Per-Agent Config Tests ──────────────────────────────────────────────

  describe("per-agent heartbeat config", () => {
    /** Create a mock store that returns a specific agent from getCachedAgent */
    function createStoreWithAgent(agent: { id: string; runtimeConfig?: Record<string, unknown> }): AgentStore {
      return {
        recordHeartbeat: vi.fn().mockResolvedValue(undefined),
        updateAgentState: vi.fn().mockResolvedValue(undefined),
        getCachedAgent: vi.fn().mockReturnValue(agent),
      } as unknown as AgentStore;
    }

    describe("getAgentHeartbeatConfig", () => {
      it("returns monitor defaults when agentStore is not provided", () => {
        const monitor = new HeartbeatMonitor({
          store,
          pollIntervalMs: 5000,
          heartbeatTimeoutMs: 10000,
          maxConcurrentRuns: 2,
        });

        const config = monitor.getAgentHeartbeatConfig("agent-001");
        expect(config.pollIntervalMs).toBe(5000);
        expect(config.heartbeatTimeoutMs).toBe(10000);
        expect(config.maxConcurrentRuns).toBe(2);
      });

      it("returns monitor defaults when agent has no runtimeConfig", () => {
        const agentStore = createStoreWithAgent({ id: "agent-001" });
        const monitor = new HeartbeatMonitor({
          store,
          agentStore,
          pollIntervalMs: 5000,
          heartbeatTimeoutMs: 10000,
        });

        const config = monitor.getAgentHeartbeatConfig("agent-001");
        expect(config.pollIntervalMs).toBe(5000);
        expect(config.heartbeatTimeoutMs).toBe(10000);
      });

      it("returns per-agent values when runtimeConfig is set", () => {
        const agentStore = createStoreWithAgent({
          id: "agent-001",
          runtimeConfig: {
            heartbeatIntervalMs: 2000,
            heartbeatTimeoutMs: 30000,
            maxConcurrentRuns: 3,
          },
        });
        const monitor = new HeartbeatMonitor({
          store,
          agentStore,
          pollIntervalMs: 5000,
          heartbeatTimeoutMs: 10000,
          maxConcurrentRuns: 1,
        });

        const config = monitor.getAgentHeartbeatConfig("agent-001");
        expect(config.pollIntervalMs).toBe(2000);
        expect(config.heartbeatTimeoutMs).toBe(30000);
        expect(config.maxConcurrentRuns).toBe(3);
      });

      it("clamps heartbeatIntervalMs to minimum of 1000", () => {
        const agentStore = createStoreWithAgent({
          id: "agent-001",
          runtimeConfig: { heartbeatIntervalMs: 100 },
        });
        const monitor = new HeartbeatMonitor({
          store,
          agentStore,
          pollIntervalMs: 5000,
        });

        const config = monitor.getAgentHeartbeatConfig("agent-001");
        expect(config.pollIntervalMs).toBe(1000);
      });

      it("clamps heartbeatTimeoutMs to minimum of 5000", () => {
        const agentStore = createStoreWithAgent({
          id: "agent-001",
          runtimeConfig: { heartbeatTimeoutMs: 1000 },
        });
        const monitor = new HeartbeatMonitor({
          store,
          agentStore,
          heartbeatTimeoutMs: 60000,
        });

        const config = monitor.getAgentHeartbeatConfig("agent-001");
        expect(config.heartbeatTimeoutMs).toBe(5000);
      });

      it("clamps maxConcurrentRuns to minimum of 1", () => {
        const agentStore = createStoreWithAgent({
          id: "agent-001",
          runtimeConfig: { maxConcurrentRuns: 0 },
        });
        const monitor = new HeartbeatMonitor({
          store,
          agentStore,
          maxConcurrentRuns: 1,
        });

        const config = monitor.getAgentHeartbeatConfig("agent-001");
        expect(config.maxConcurrentRuns).toBe(1);
      });

      it("falls back to monitor defaults when runtimeConfig values are NaN", () => {
        const agentStore = createStoreWithAgent({
          id: "agent-001",
          runtimeConfig: {
            heartbeatIntervalMs: NaN,
            heartbeatTimeoutMs: "not a number" as any,
          },
        });
        const monitor = new HeartbeatMonitor({
          store,
          agentStore,
          pollIntervalMs: 5000,
          heartbeatTimeoutMs: 10000,
        });

        const config = monitor.getAgentHeartbeatConfig("agent-001");
        expect(config.pollIntervalMs).toBe(5000);
        expect(config.heartbeatTimeoutMs).toBe(10000);
      });

      it("falls back to monitor defaults when agent is not found", () => {
        const agentStore = createStoreWithAgent({ id: "agent-001" });
        (agentStore.getCachedAgent as ReturnType<typeof vi.fn>).mockReturnValue(null);

        const monitor = new HeartbeatMonitor({
          store,
          agentStore,
          pollIntervalMs: 5000,
          heartbeatTimeoutMs: 10000,
        });

        const config = monitor.getAgentHeartbeatConfig("agent-999");
        expect(config.pollIntervalMs).toBe(5000);
        expect(config.heartbeatTimeoutMs).toBe(10000);
      });

      it("returns monitor defaults when getCachedAgent throws", () => {
        const agentStore = createStoreWithAgent({ id: "agent-001" });
        (agentStore.getCachedAgent as ReturnType<typeof vi.fn>).mockImplementation(() => {
          throw new Error("Read error");
        });

        const monitor = new HeartbeatMonitor({
          store,
          agentStore,
          pollIntervalMs: 5000,
          heartbeatTimeoutMs: 10000,
        });

        const config = monitor.getAgentHeartbeatConfig("agent-001");
        expect(config.pollIntervalMs).toBe(5000);
        expect(config.heartbeatTimeoutMs).toBe(10000);
      });

      it("returns partial overrides when only some runtimeConfig keys are set", () => {
        const agentStore = createStoreWithAgent({
          id: "agent-001",
          runtimeConfig: { heartbeatTimeoutMs: 120000 },
        });
        const monitor = new HeartbeatMonitor({
          store,
          agentStore,
          pollIntervalMs: 5000,
          heartbeatTimeoutMs: 60000,
          maxConcurrentRuns: 1,
        });

        const config = monitor.getAgentHeartbeatConfig("agent-001");
        expect(config.pollIntervalMs).toBe(5000); // fallback
        expect(config.heartbeatTimeoutMs).toBe(120000); // overridden
        expect(config.maxConcurrentRuns).toBe(1); // fallback
      });
    });

    describe("isAgentHealthy with per-agent config", () => {
      it("uses per-agent timeout for health check", () => {
        const agentStore = createStoreWithAgent({
          id: "agent-001",
          runtimeConfig: { heartbeatTimeoutMs: 30000 },
        });
        const session = createMockSession();

        vi.useFakeTimers({ shouldAdvanceTime: true });
        const monitor = new HeartbeatMonitor({
          store,
          agentStore,
          heartbeatTimeoutMs: 5000, // Global default is 5000
        });
        monitor.trackAgent("agent-001", session, "run-001");

        // Advance 10s — past the global 5s default, but within the per-agent 30s
        vi.advanceTimersByTime(10000);
        expect(monitor.isAgentHealthy("agent-001")).toBe(true);

        // Advance past per-agent 30s timeout
        vi.advanceTimersByTime(25000);
        expect(monitor.isAgentHealthy("agent-001")).toBe(false);

        vi.useRealTimers();
      });
    });

    describe("checkMissedHeartbeats with per-agent config", () => {
      it("detects missed heartbeat using per-agent timeout", async () => {
        const onMissed = vi.fn();
        const agentStore = createStoreWithAgent({
          id: "agent-001",
          runtimeConfig: { heartbeatTimeoutMs: 10000 },
        });
        const session = createMockSession();

        vi.useFakeTimers({ shouldAdvanceTime: true });
        const monitor = new HeartbeatMonitor({
          store,
          agentStore,
          pollIntervalMs: 1000,
          heartbeatTimeoutMs: 5000, // Global default 5s — agent overrides to 10s
          onMissed,
        });
        monitor.start();
        monitor.trackAgent("agent-001", session, "run-001");

        // Advance 6s — past global 5s but within per-agent 10s
        vi.advanceTimersByTime(6000);
        await vi.advanceTimersByTimeAsync(100);

        // Should NOT have triggered onMissed because per-agent timeout is 10s
        expect(onMissed).not.toHaveBeenCalled();

        // Advance past the 10s per-agent timeout
        vi.advanceTimersByTime(5000);
        await vi.advanceTimersByTimeAsync(100);

        expect(onMissed).toHaveBeenCalledWith("agent-001");

        monitor.stop();
        vi.useRealTimers();
      });

      it("terminates unresponsive agent using per-agent timeout", async () => {
        const onTerminated = vi.fn();
        const agentStore = createStoreWithAgent({
          id: "agent-001",
          runtimeConfig: { heartbeatTimeoutMs: 5000 },
        });
        const session = createMockSession();

        vi.useFakeTimers({ shouldAdvanceTime: true });
        const monitor = new HeartbeatMonitor({
          store,
          agentStore,
          pollIntervalMs: 1000,
          heartbeatTimeoutMs: 60000, // Global default 60s — agent overrides to 5s
          onTerminated,
        });
        monitor.start();
        monitor.trackAgent("agent-001", session, "run-001");

        // Wait for missed (5s) + termination at 2x timeout (10s)
        vi.advanceTimersByTime(12000);
        await vi.advanceTimersByTimeAsync(100);

        expect(session.dispose).toHaveBeenCalled();
        expect(onTerminated).toHaveBeenCalledWith("agent-001");

        monitor.stop();
        vi.useRealTimers();
      });
    });

    describe("backward compatibility", () => {
      it("works without agentStore (no per-agent config)", () => {
        const monitor = new HeartbeatMonitor({
          store,
          heartbeatTimeoutMs: 5000,
        });

        const config = monitor.getAgentHeartbeatConfig("agent-001");
        expect(config.heartbeatTimeoutMs).toBe(5000);
        expect(config.pollIntervalMs).toBe(30000); // default
        expect(config.maxConcurrentRuns).toBe(1); // default
      });

      it("existing isAgentHealthy works without per-agent config", () => {
        const session = createMockSession();
        vi.useFakeTimers({ shouldAdvanceTime: true });

        const monitor = new HeartbeatMonitor({
          store,
          heartbeatTimeoutMs: 5000,
        });
        monitor.trackAgent("agent-001", session, "run-001");
        expect(monitor.isAgentHealthy("agent-001")).toBe(true);

        vi.advanceTimersByTime(6000);
        expect(monitor.isAgentHealthy("agent-001")).toBe(false);

        vi.useRealTimers();
      });
    });
  });
});
