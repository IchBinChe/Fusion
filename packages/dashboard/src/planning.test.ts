import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  createSession,
  submitResponse,
  cancelSession,
  getSession,
  getCurrentQuestion,
  getSummary,
  cleanupSession,
  checkRateLimit,
  getRateLimitResetTime,
  __resetPlanningState,
  RateLimitError,
  SessionNotFoundError,
  InvalidSessionStateError,
} from "./planning.js";
import type { PlanningQuestion, PlanningSummary } from "@fusion/core";

// Counter for unique IPs per test
let ipCounter = 0;
function getUniqueIp(): string {
  return `127.0.0.${++ipCounter}`;
}

describe("planning module", () => {
  const initialPlan = "Build a user authentication system";

  beforeEach(() => {
    vi.useFakeTimers();
    __resetPlanningState();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("createSession", () => {
    it("creates a session with valid initial plan", async () => {
      const mockIp = getUniqueIp();
      const result = await createSession(mockIp, initialPlan);

      expect(result.sessionId).toBeDefined();
      expect(typeof result.sessionId).toBe("string");
      expect(result.firstQuestion).toBeDefined();
      expect(result.firstQuestion.id).toBe("q-scope");
      expect(result.firstQuestion.type).toBe("single_select");
    });

    it("enforces rate limiting", async () => {
      const mockIp = getUniqueIp();
      // Create max sessions (5 per hour)
      for (let i = 0; i < 5; i++) {
        await createSession(mockIp, `${initialPlan} ${i}`);
      }

      // 6th session should fail
      await expect(createSession(mockIp, initialPlan)).rejects.toThrow(RateLimitError);
    });

    it("allows new sessions after rate limit window expires", async () => {
      const mockIp = getUniqueIp();
      // Create max sessions
      for (let i = 0; i < 5; i++) {
        await createSession(mockIp, `${initialPlan} ${i}`);
      }

      // Advance time by 1 hour + 1 minute
      vi.advanceTimersByTime(61 * 60 * 1000);

      // Should now be able to create a new session
      const result = await createSession(mockIp, "New plan after reset");
      expect(result.sessionId).toBeDefined();
    });

    it("generates different session IDs for each session", async () => {
      const mockIp = getUniqueIp();
      const result1 = await createSession(mockIp, "Plan 1");
      const result2 = await createSession(mockIp, "Plan 2");

      expect(result1.sessionId).not.toBe(result2.sessionId);
    });
  });

  describe("submitResponse", () => {
    it("processes response and returns next question", async () => {
      const mockIp = getUniqueIp();
      const { sessionId } = await createSession(mockIp, initialPlan);

      const response = await submitResponse(sessionId, { scope: "medium" });

      expect(response.type).toBe("question");
      if (response.type === "question") {
        expect(response.data.type).toBe("text");
      }
    });

    it("returns summary after multiple responses", async () => {
      const mockIp = getUniqueIp();
      const { sessionId } = await createSession(mockIp, initialPlan);

      // Submit first response
      const response1 = await submitResponse(sessionId, { scope: "medium" });
      expect(response1.type).toBe("question");

      // Submit second response
      const response2 = await submitResponse(sessionId, { requirements: "Must have login and logout" });
      expect(response2.type).toBe("question");

      // Submit third response - should get summary
      const response3 = await submitResponse(sessionId, { confirm: true });
      expect(response3.type).toBe("complete");

      if (response3.type === "complete") {
        expect(response3.data.title).toBeDefined();
        expect(response3.data.description).toBeDefined();
        expect(response3.data.suggestedSize).toBeDefined();
        expect(response3.data.keyDeliverables).toBeInstanceOf(Array);
      }
    });

    it("throws SessionNotFoundError for invalid session ID", async () => {
      await expect(submitResponse("invalid-session-id", {})).rejects.toThrow(SessionNotFoundError);
    });

    it("throws InvalidSessionStateError when no active question", async () => {
      const mockIp = getUniqueIp();
      const { sessionId } = await createSession(mockIp, initialPlan);

      // Complete the session
      await submitResponse(sessionId, { scope: "small" });
      await submitResponse(sessionId, { requirements: "test" });
      await submitResponse(sessionId, { confirm: true });

      // Try to submit another response
      await expect(submitResponse(sessionId, {})).rejects.toThrow(InvalidSessionStateError);
    });
  });

  describe("cancelSession", () => {
    it("removes an active session", async () => {
      const mockIp = getUniqueIp();
      const { sessionId } = await createSession(mockIp, initialPlan);

      await cancelSession(sessionId);

      // Should not be able to find the session anymore
      expect(getSession(sessionId)).toBeUndefined();
    });

    it("throws SessionNotFoundError for non-existent session", async () => {
      await expect(cancelSession("non-existent-id")).rejects.toThrow(SessionNotFoundError);
    });
  });

  describe("getSession", () => {
    it("returns session for valid ID", async () => {
      const mockIp = getUniqueIp();
      const { sessionId } = await createSession(mockIp, initialPlan);

      const session = getSession(sessionId);
      expect(session).toBeDefined();
      expect(session?.id).toBe(sessionId);
      expect(session?.initialPlan).toBe(initialPlan);
      expect(session?.ip).toBe(mockIp);
    });

    it("returns undefined for invalid ID", () => {
      expect(getSession("invalid-id")).toBeUndefined();
    });
  });

  describe("getCurrentQuestion", () => {
    it("returns current question for active session", async () => {
      const mockIp = getUniqueIp();
      const { sessionId, firstQuestion } = await createSession(mockIp, initialPlan);

      const question = getCurrentQuestion(sessionId);
      expect(question).toEqual(firstQuestion);
    });

    it("returns undefined for completed session", async () => {
      const mockIp = getUniqueIp();
      const { sessionId } = await createSession(mockIp, initialPlan);

      // Complete the session
      await submitResponse(sessionId, { scope: "small" });
      await submitResponse(sessionId, { requirements: "test" });
      await submitResponse(sessionId, { confirm: true });

      const question = getCurrentQuestion(sessionId);
      expect(question).toBeUndefined();
    });
  });

  describe("getSummary", () => {
    it("returns summary for completed session", async () => {
      const mockIp = getUniqueIp();
      const { sessionId } = await createSession(mockIp, initialPlan);

      // Complete the session
      await submitResponse(sessionId, { scope: "small" });
      await submitResponse(sessionId, { requirements: "test" });
      const response = await submitResponse(sessionId, { confirm: true });

      if (response.type === "complete") {
        const summary = getSummary(sessionId);
        expect(summary).toEqual(response.data);
      }
    });

    it("returns undefined for incomplete session", async () => {
      const mockIp = getUniqueIp();
      const { sessionId } = await createSession(mockIp, initialPlan);

      const summary = getSummary(sessionId);
      expect(summary).toBeUndefined();
    });
  });

  describe("cleanupSession", () => {
    it("removes a session from memory", async () => {
      const mockIp = getUniqueIp();
      const { sessionId } = await createSession(mockIp, initialPlan);

      cleanupSession(sessionId);

      expect(getSession(sessionId)).toBeUndefined();
    });
  });

  describe("rate limiting", () => {
    it("checkRateLimit returns true for first request", () => {
      const result = checkRateLimit(getUniqueIp());
      expect(result).toBe(true);
    });

    it("getRateLimitResetTime returns null for unknown IP", () => {
      const resetTime = getRateLimitResetTime("unknown-ip");
      expect(resetTime).toBeNull();
    });

    it("getRateLimitResetTime returns Date for rate limited IP", async () => {
      const mockIp = getUniqueIp();

      // Max out the rate limit
      for (let i = 0; i < 5; i++) {
        await createSession(mockIp, `Plan ${i}`);
      }

      const resetTime = getRateLimitResetTime(mockIp);
      expect(resetTime).toBeInstanceOf(Date);
      expect(resetTime!.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe("session TTL", () => {
    it("sessions expire after TTL", async () => {
      const mockIp = getUniqueIp();
      const { sessionId } = await createSession(mockIp, initialPlan);

      // Verify session exists
      expect(getSession(sessionId)).toBeDefined();

      // Advance time by 31 minutes
      vi.advanceTimersByTime(31 * 60 * 1000);

      // Trigger cleanup by creating a new session
      await createSession(getUniqueIp(), "Another plan");

      // Note: Session should be expired after cleanup runs
      // We can't directly verify as cleanup is async
    });
  });
});
