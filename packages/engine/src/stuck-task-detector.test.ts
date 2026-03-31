import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StuckTaskDetector } from "./stuck-task-detector.js";
import type { TaskStore } from "@fusion/core";

// Mock store factory
function createMockStore(overrides: Partial<TaskStore> = {}): TaskStore {
  return {
    getSettings: vi.fn().mockResolvedValue({}),
    logEntry: vi.fn().mockResolvedValue(undefined),
    updateTask: vi.fn().mockResolvedValue(undefined),
    moveTask: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as TaskStore;
}

// Mock disposable session
function createMockSession(): { dispose: ReturnType<typeof vi.fn> } {
  return {
    dispose: vi.fn(),
  };
}

describe("StuckTaskDetector", () => {
  let store: TaskStore;
  let detector: StuckTaskDetector;

  beforeEach(() => {
    store = createMockStore();
    detector = new StuckTaskDetector(store);
  });

  afterEach(() => {
    detector.stop();
  });

  describe("constructor", () => {
    it("initializes with default options", () => {
      expect(detector).toBeDefined();
      expect(detector.trackedCount).toBe(0);
    });

    it("accepts custom poll interval", () => {
      const customDetector = new StuckTaskDetector(store, { pollIntervalMs: 5000 });
      expect(customDetector).toBeDefined();
    });

    it("accepts onStuck callback", () => {
      const onStuck = vi.fn();
      const customDetector = new StuckTaskDetector(store, { onStuck });
      expect(customDetector).toBeDefined();
    });
  });

  describe("start/stop", () => {
    it("starts and stops the polling loop", () => {
      detector.start();
      detector.stop();
      // Should not throw
    });

    it("is safe to stop when not started", () => {
      detector.stop();
      // Should not throw
    });

    it("is safe to start multiple times", () => {
      detector.start();
      detector.start(); // Second call should no-op
      detector.stop();
    });
  });

  describe("trackTask", () => {
    it("adds task to tracking", () => {
      const session = createMockSession();
      detector.trackTask("KB-001", session);
      expect(detector.trackedCount).toBe(1);
    });

    it("sets initial activity timestamp", () => {
      const session = createMockSession();
      const before = Date.now();
      detector.trackTask("KB-001", session);
      const after = Date.now();

      const lastActivity = detector.getLastActivity("KB-001");
      expect(lastActivity).toBeDefined();
      expect(lastActivity).toBeGreaterThanOrEqual(before);
      expect(lastActivity).toBeLessThanOrEqual(after);
    });

    it("can track multiple tasks", () => {
      detector.trackTask("KB-001", createMockSession());
      detector.trackTask("KB-002", createMockSession());
      expect(detector.trackedCount).toBe(2);
    });
  });

  describe("untrackTask", () => {
    it("removes task from tracking", () => {
      detector.trackTask("KB-001", createMockSession());
      expect(detector.trackedCount).toBe(1);

      detector.untrackTask("KB-001");
      expect(detector.trackedCount).toBe(0);
    });

    it("is safe to untrack untracked task", () => {
      detector.untrackTask("KB-001");
      expect(detector.trackedCount).toBe(0);
    });
  });

  describe("recordActivity", () => {
    it("updates last activity timestamp", () => {
      const session = createMockSession();
      vi.useFakeTimers({ shouldAdvanceTime: true });
      
      detector.trackTask("KB-001", session);
      const initialActivity = detector.getLastActivity("KB-001")!;

      // Advance time
      vi.advanceTimersByTime(10);
      detector.recordActivity("KB-001");

      const newActivity = detector.getLastActivity("KB-001")!;
      expect(newActivity).toBeGreaterThanOrEqual(initialActivity);

      vi.useRealTimers();
    });

    it("does nothing for untracked task", () => {
      // Should not throw
      detector.recordActivity("KB-001");
    });
  });

  describe("isStuck", () => {
    it("returns false when no timeout exceeded", () => {
      const session = createMockSession();
      detector.trackTask("KB-001", session);

      expect(detector.isStuck("KB-001", 60000)).toBe(false);
    });

    it("returns true when timeout exceeded", () => {
      const session = createMockSession();
      vi.useFakeTimers({ shouldAdvanceTime: true });

      detector.trackTask("KB-001", session);
      vi.advanceTimersByTime(61000); // Advance 61 seconds

      expect(detector.isStuck("KB-001", 60000)).toBe(true);

      vi.useRealTimers();
    });

    it("returns false for untracked task", () => {
      expect(detector.isStuck("KB-001", 60000)).toBe(false);
    });
  });

  describe("killAndRetry", () => {
    it("disposes the session", async () => {
      const session = createMockSession();
      detector.trackTask("KB-001", session);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.advanceTimersByTime(61000);

      await detector.killAndRetry("KB-001", 60000);

      expect(session.dispose).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("removes task from tracking", async () => {
      const session = createMockSession();
      detector.trackTask("KB-001", session);
      expect(detector.trackedCount).toBe(1);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.advanceTimersByTime(61000);

      await detector.killAndRetry("KB-001", 60000);

      expect(detector.trackedCount).toBe(0);

      vi.useRealTimers();
    });

    it("logs to task log", async () => {
      const session = createMockSession();
      detector.trackTask("KB-001", session);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.advanceTimersByTime(61000);

      await detector.killAndRetry("KB-001", 60000);

      expect(store.logEntry).toHaveBeenCalledWith(
        "KB-001",
        expect.stringContaining("Task terminated due to stuck agent session")
      );

      vi.useRealTimers();
    });

    it("updates task status and moves to todo", async () => {
      const session = createMockSession();
      detector.trackTask("KB-001", session);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.advanceTimersByTime(61000);

      await detector.killAndRetry("KB-001", 60000);

      expect(store.updateTask).toHaveBeenCalledWith("KB-001", { status: "stuck-killed" });
      expect(store.moveTask).toHaveBeenCalledWith("KB-001", "todo");

      vi.useRealTimers();
    });

    it("calls onStuck callback", async () => {
      const onStuck = vi.fn();
      const customDetector = new StuckTaskDetector(store, { onStuck });
      const session = createMockSession();

      customDetector.trackTask("KB-001", session);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.advanceTimersByTime(61000);

      await customDetector.killAndRetry("KB-001", 60000);

      expect(onStuck).toHaveBeenCalledWith("KB-001");

      vi.useRealTimers();
    });

    it("does nothing for untracked task", async () => {
      await detector.killAndRetry("KB-001", 60000);
      // Should not throw
      expect(store.moveTask).not.toHaveBeenCalled();
    });
  });

  describe("checkNow", () => {
    it("checks stuck tasks immediately", async () => {
      store = createMockStore({
        getSettings: vi.fn().mockResolvedValue({ taskStuckTimeoutMs: 60000 }),
      });
      const customDetector = new StuckTaskDetector(store);
      const session = createMockSession();

      customDetector.trackTask("KB-001", session);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.advanceTimersByTime(61000);

      await customDetector.checkNow();

      expect(store.moveTask).toHaveBeenCalledWith("KB-001", "todo");

      vi.useRealTimers();
    });
  });

  describe("checkStuckTasks (via polling)", () => {
    it("does nothing when no tasks tracked", async () => {
      store = createMockStore({
        getSettings: vi.fn().mockResolvedValue({ taskStuckTimeoutMs: 60000 }),
      });
      const customDetector = new StuckTaskDetector(store);

      // Start and let it poll
      customDetector.start();
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.advanceTimersByTime(35000); // Default poll interval is 30s

      expect(store.moveTask).not.toHaveBeenCalled();

      customDetector.stop();
      vi.useRealTimers();
    });

    it("does nothing when timeout is disabled", async () => {
      store = createMockStore({
        getSettings: vi.fn().mockResolvedValue({ taskStuckTimeoutMs: undefined }),
      });
      const customDetector = new StuckTaskDetector(store);
      const session = createMockSession();

      customDetector.trackTask("KB-001", session);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.advanceTimersByTime(61000);

      await customDetector.checkNow();

      expect(store.moveTask).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("does nothing when timeout is zero or negative", async () => {
      store = createMockStore({
        getSettings: vi.fn().mockResolvedValue({ taskStuckTimeoutMs: 0 }),
      });
      const customDetector = new StuckTaskDetector(store);
      const session = createMockSession();

      customDetector.trackTask("KB-001", session);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.advanceTimersByTime(61000);

      await customDetector.checkNow();

      expect(store.moveTask).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("skips check when settings cannot be read", async () => {
      store = createMockStore({
        getSettings: vi.fn().mockRejectedValue(new Error("Settings error")),
      });
      const customDetector = new StuckTaskDetector(store);
      const session = createMockSession();

      customDetector.trackTask("KB-001", session);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.advanceTimersByTime(61000);

      await customDetector.checkNow();

      // Should not throw, just skip
      expect(store.moveTask).not.toHaveBeenCalled();

      vi.useRealTimers();
    });
  });
});
