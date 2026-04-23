/**
 * Runtime Adapter Tests
 *
 * Tests for the PaperclipRuntimeAdapter class.
 *
 * ## Mocking Strategy
 *
 * The adapter imports pi functions from a seam module (./pi-module.js) which
 * re-exports them from the engine. This allows Vitest to mock the seam directly,
 * enabling behavioral tests of the adapter's delegation to pi functions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PaperclipRuntimeAdapter } from "../runtime-adapter.js";

// ── Mock Modules ────────────────────────────────────────────────────────────────

// Use vi.hoisted() so Vitest properly handles the hoisted mock reference
const { mockCreateFnAgent, mockPromptWithFallback, mockDescribeModel } = vi.hoisted(() => ({
  mockCreateFnAgent: vi.fn(),
  mockPromptWithFallback: vi.fn(),
  mockDescribeModel: vi.fn(),
}));

// Mock the pi-module seam so the adapter uses our mock functions
vi.mock("../pi-module.js", () => ({
  createFnAgent: mockCreateFnAgent,
  promptWithFallback: mockPromptWithFallback,
  describeModel: mockDescribeModel,
}));

// ── Test Suite ─────────────────────────────────────────────────────────────────

describe("PaperclipRuntimeAdapter", () => {
  let adapter: PaperclipRuntimeAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock return values
    mockDescribeModel.mockReturnValue("mock/anthropic-claude");
    adapter = new PaperclipRuntimeAdapter();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("runtime identity", () => {
    it("should have id 'paperclip'", () => {
      expect(adapter.id).toBe("paperclip");
    });

    it("should have name 'Paperclip Runtime'", () => {
      expect(adapter.name).toBe("Paperclip Runtime");
    });
  });

  describe("createSession", () => {
    it("should call createFnAgent with all options mapped correctly", async () => {
      const mockSession = { dispose: vi.fn() };
      const mockResult = { session: mockSession, sessionFile: "/path/to/session.json" };
      mockCreateFnAgent.mockResolvedValue(mockResult);

      const options = {
        cwd: "/project",
        systemPrompt: "You are helpful",
        skills: ["bash", "read"],
      };

      const result = await adapter.createSession(options);

      expect(mockCreateFnAgent).toHaveBeenCalledTimes(1);
      expect(mockCreateFnAgent).toHaveBeenCalledWith({
        cwd: "/project",
        systemPrompt: "You are helpful",
        tools: undefined,
        customTools: undefined,
        onText: undefined,
        onThinking: undefined,
        onToolStart: undefined,
        onToolEnd: undefined,
        defaultProvider: undefined,
        defaultModelId: undefined,
        fallbackProvider: undefined,
        fallbackModelId: undefined,
        defaultThinkingLevel: undefined,
        sessionManager: undefined,
        skillSelection: undefined,
        skills: ["bash", "read"],
      });
      expect(result.session).toBe(mockSession);
      expect(result.sessionFile).toBe("/path/to/session.json");
    });

    it("should pass through model provider options", async () => {
      mockCreateFnAgent.mockResolvedValue({ session: {} });

      await adapter.createSession({
        cwd: "/project",
        systemPrompt: "Test",
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
        fallbackProvider: "openai",
        fallbackModelId: "gpt-4o",
      });

      expect(mockCreateFnAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultProvider: "anthropic",
          defaultModelId: "claude-sonnet-4-5",
          fallbackProvider: "openai",
          fallbackModelId: "gpt-4o",
        }),
      );
    });

    it("should pass through custom tools", async () => {
      mockCreateFnAgent.mockResolvedValue({ session: {} });
      const customTools = [{ name: "custom_tool", execute: vi.fn() }];

      await adapter.createSession({
        cwd: "/project",
        systemPrompt: "Test",
        customTools,
      });

      expect(mockCreateFnAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          customTools,
        }),
      );
    });

    it("should pass through skill selection context", async () => {
      mockCreateFnAgent.mockResolvedValue({ session: {} });
      const skillSelection = {
        projectRootDir: "/project",
        requestedSkillNames: ["bash"],
        sessionPurpose: "executor" as const,
      };

      await adapter.createSession({
        cwd: "/project",
        systemPrompt: "Test",
        skillSelection,
      });

      expect(mockCreateFnAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          skillSelection,
        }),
      );
    });

    it("should pass through event handlers", async () => {
      mockCreateFnAgent.mockResolvedValue({ session: {} });
      const onText = vi.fn();
      const onThinking = vi.fn();
      const onToolStart = vi.fn();
      const onToolEnd = vi.fn();

      await adapter.createSession({
        cwd: "/project",
        systemPrompt: "Test",
        onText,
        onThinking,
        onToolStart,
        onToolEnd,
      });

      expect(mockCreateFnAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          onText,
          onThinking,
          onToolStart,
          onToolEnd,
        }),
      );
    });

    it("should pass through thinking level and session manager", async () => {
      mockCreateFnAgent.mockResolvedValue({ session: {} });
      const sessionManager = { maxHistory: 100 };

      await adapter.createSession({
        cwd: "/project",
        systemPrompt: "Test",
        defaultThinkingLevel: "medium",
        sessionManager,
      });

      expect(mockCreateFnAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultThinkingLevel: "medium",
          sessionManager,
        }),
      );
    });
  });

  describe("promptWithFallback", () => {
    it("should delegate to promptWithFallback from pi module with options", async () => {
      const mockSession = { id: "test-session" };
      mockPromptWithFallback.mockResolvedValue(undefined);

      await adapter.promptWithFallback(mockSession as any, "Hello", { images: [] });

      expect(mockPromptWithFallback).toHaveBeenCalledTimes(1);
      expect(mockPromptWithFallback).toHaveBeenCalledWith(mockSession, "Hello", { images: [] });
    });

    it("should delegate to promptWithFallback without options", async () => {
      mockPromptWithFallback.mockResolvedValue(undefined);

      await adapter.promptWithFallback({} as any, "Hello");

      expect(mockPromptWithFallback).toHaveBeenCalledTimes(1);
      expect(mockPromptWithFallback).toHaveBeenCalledWith({}, "Hello", undefined);
    });

    it("should forward session object directly to pi", async () => {
      const mockSession = {
        id: "session-123",
        model: { provider: "anthropic", id: "claude-sonnet-4-5" },
      };
      mockPromptWithFallback.mockResolvedValue(undefined);

      await adapter.promptWithFallback(mockSession as any, "Tell me a joke");

      expect(mockPromptWithFallback).toHaveBeenCalledWith(mockSession, "Tell me a joke", undefined);
      expect(mockSession.id).toBe("session-123");
    });
  });

  describe("describeModel", () => {
    it("should return model description from pi describeModel", () => {
      const mockSession = { model: { provider: "anthropic", id: "claude-sonnet-4-5" } };
      mockDescribeModel.mockReturnValue("anthropic/claude-sonnet-4-5");

      const result = adapter.describeModel(mockSession as any);

      expect(mockDescribeModel).toHaveBeenCalledTimes(1);
      expect(mockDescribeModel).toHaveBeenCalledWith(mockSession);
      expect(result).toBe("anthropic/claude-sonnet-4-5");
    });

    it("should return unknown model when session has no model", () => {
      mockDescribeModel.mockReturnValue("unknown model");

      const result = adapter.describeModel({} as any);

      expect(mockDescribeModel).toHaveBeenCalledWith({});
      expect(result).toBe("unknown model");
    });

    it("should forward the session object directly to pi describeModel", () => {
      const mockSession = { id: "test-session", model: { provider: "openai", id: "gpt-4o" } };
      mockDescribeModel.mockReturnValue("openai/gpt-4o");

      adapter.describeModel(mockSession as any);

      expect(mockDescribeModel).toHaveBeenCalledWith(mockSession);
    });
  });

  describe("dispose", () => {
    it("should call session.dispose() when available", async () => {
      const disposeMock = vi.fn().mockResolvedValue(undefined);
      const mockSession = { dispose: disposeMock } as any;

      await adapter.dispose(mockSession);

      expect(disposeMock).toHaveBeenCalledTimes(1);
    });

    it("should be a no-op when session has no dispose method", async () => {
      const mockSession = { id: "test" } as any;

      // Should not throw
      await expect(adapter.dispose(mockSession)).resolves.toBeUndefined();
    });

    it("should handle dispose that throws", async () => {
      const disposeMock = vi.fn().mockRejectedValue(new Error("Dispose failed"));
      const mockSession = { dispose: disposeMock } as any;

      await expect(adapter.dispose(mockSession)).rejects.toThrow("Dispose failed");
    });
  });
});
