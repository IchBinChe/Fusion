import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractRuntimeHint,
  extractRuntimeModel,
  resolveExecutorSessionModel,
  resolveHeartbeatSessionModels,
  resolveMergerSessionModel,
  resolvePlanningSessionModel,
  resolveValidatorSessionModel,
} from "../agent-session-helpers.js";

const { resolveRuntimeMock } = vi.hoisted(() => ({
  resolveRuntimeMock: vi.fn(),
}));

vi.mock("../runtime-resolution.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime-resolution.js")>("../runtime-resolution.js");
  return {
    ...actual,
    resolveRuntime: resolveRuntimeMock,
  };
});

describe("extractRuntimeHint", () => {
  it("returns undefined for undefined config", () => {
    expect(extractRuntimeHint(undefined)).toBeUndefined();
  });

  it("returns undefined when runtimeHint key is missing", () => {
    expect(extractRuntimeHint({})).toBeUndefined();
  });

  it("returns normalized runtime hint when configured", () => {
    expect(extractRuntimeHint({ runtimeHint: " openclaw " })).toBe("openclaw");
  });

  it("returns undefined for whitespace-only runtimeHint", () => {
    expect(extractRuntimeHint({ runtimeHint: "   " })).toBeUndefined();
  });

  it("returns undefined for non-string runtimeHint", () => {
    expect(extractRuntimeHint({ runtimeHint: 42 })).toBeUndefined();
  });
});

describe("extractRuntimeModel", () => {
  it("parses combined and separate runtime model pairs", () => {
    expect(extractRuntimeModel({ model: " anthropic/claude-sonnet-4-5 " })).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });
    expect(extractRuntimeModel({ modelProvider: " openai ", modelId: " gpt-4.1 " })).toEqual({
      provider: "openai",
      modelId: "gpt-4.1",
    });
  });

  it("does not turn malformed combined strings into complete model pairs", () => {
    expect(extractRuntimeModel({ model: "gpt 5.3" })).toEqual({
      provider: undefined,
      modelId: undefined,
    });
  });
});

describe("resolve session model parity", () => {
  const settings = {
    executionProvider: "openai",
    executionModelId: "gpt-4.1",
    planningProvider: "anthropic",
    planningModelId: "claude-sonnet-4-5",
    defaultProviderOverride: "google",
    defaultModelIdOverride: "gemini-2.5-pro",
    defaultProvider: "zai",
    defaultModelId: "glm-5.1",
  };

  it("uses the same fresh settings model for executor and heartbeat when runtimeConfig is absent", () => {
    const executor = resolveExecutorSessionModel(undefined, undefined, settings);
    const heartbeat = resolveHeartbeatSessionModels(settings);

    expect(executor).toEqual({ provider: "openai", modelId: "gpt-4.1" });
    expect(heartbeat).toEqual({
      defaultProvider: executor.provider,
      defaultModelId: executor.modelId,
      fallbackProvider: undefined,
      fallbackModelId: undefined,
    });
  });

  it("ignores partial runtimeConfig pairs without mixing runtime and settings fields", () => {
    expect(resolveHeartbeatSessionModels(
      {
        executionProvider: "openai",
        executionModelId: "gpt-4.1",
      },
      { modelProvider: "stale-provider" },
    )).toEqual({
      defaultProvider: "openai",
      defaultModelId: "gpt-4.1",
      fallbackProvider: undefined,
      fallbackModelId: undefined,
    });

    expect(resolveHeartbeatSessionModels(
      {
        executionProvider: "openai",
        executionModelId: "gpt-4.1",
      },
      { modelId: "gpt 5.3" },
    )).toEqual({
      defaultProvider: "openai",
      defaultModelId: "gpt-4.1",
      fallbackProvider: undefined,
      fallbackModelId: undefined,
    });
  });

  it("does not let a stale complete runtime model mask newer task or settings models", () => {
    const staleRuntimeConfig = { model: "openai-codex/gpt-5.3-codex" };

    expect(resolveExecutorSessionModel("task-provider", "task-model", settings, staleRuntimeConfig)).toEqual({
      provider: "task-provider",
      modelId: "task-model",
    });
    expect(resolveExecutorSessionModel(undefined, undefined, settings, staleRuntimeConfig)).toEqual({
      provider: "openai",
      modelId: "gpt-4.1",
    });
    expect(resolvePlanningSessionModel("planning-task-provider", "planning-task-model", settings, staleRuntimeConfig)).toEqual({
      provider: "planning-task-provider",
      modelId: "planning-task-model",
    });
    expect(resolvePlanningSessionModel(undefined, undefined, settings, staleRuntimeConfig)).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });
    expect(resolveHeartbeatSessionModels(settings, staleRuntimeConfig)).toEqual({
      defaultProvider: "openai",
      defaultModelId: "gpt-4.1",
      fallbackProvider: undefined,
      fallbackModelId: undefined,
    });
    expect(resolveValidatorSessionModel("validator-task-provider", "validator-task-model", settings, staleRuntimeConfig)).toEqual({
      provider: "validator-task-provider",
      modelId: "validator-task-model",
    });
    expect(resolveMergerSessionModel(settings, staleRuntimeConfig)).toEqual({
      provider: "google",
      modelId: "gemini-2.5-pro",
    });
  });

  it("does not leak malformed gpt 5.3-style runtimeConfig into any automatic lane", () => {
    const malformedRuntimeConfig = { modelId: "gpt 5.3" };

    expect(resolveExecutorSessionModel(undefined, undefined, settings, malformedRuntimeConfig)).toEqual({
      provider: "openai",
      modelId: "gpt-4.1",
    });
    expect(resolvePlanningSessionModel(undefined, undefined, settings, malformedRuntimeConfig)).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });
    expect(resolveHeartbeatSessionModels(settings, malformedRuntimeConfig)).toEqual({
      defaultProvider: "openai",
      defaultModelId: "gpt-4.1",
      fallbackProvider: undefined,
      fallbackModelId: undefined,
    });
    expect(resolveValidatorSessionModel(undefined, undefined, settings, malformedRuntimeConfig)).toEqual({
      provider: "google",
      modelId: "gemini-2.5-pro",
    });
    expect(resolveMergerSessionModel(settings, malformedRuntimeConfig)).toEqual({
      provider: "google",
      modelId: "gemini-2.5-pro",
    });
  });

  it("falls back through project override and global defaults before runtimeConfig", () => {
    const staleRuntimeConfig = { model: "stale-provider/stale-model" };

    expect(resolveMergerSessionModel({
      defaultProviderOverride: "google",
      defaultModelIdOverride: "gemini-2.5-pro",
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
    }, staleRuntimeConfig)).toEqual({ provider: "google", modelId: "gemini-2.5-pro" });
    expect(resolveMergerSessionModel({
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
    }, staleRuntimeConfig)).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
  });

  it("uses a complete runtime model only when no lane/task/default model is configured", () => {
    const runtimeConfig = { modelProvider: "anthropic", modelId: "claude-opus-4" };

    expect(resolveExecutorSessionModel(undefined, undefined, undefined, runtimeConfig)).toEqual({
      provider: "anthropic",
      modelId: "claude-opus-4",
    });
    expect(resolvePlanningSessionModel(undefined, undefined, undefined, runtimeConfig)).toEqual({
      provider: "anthropic",
      modelId: "claude-opus-4",
    });
    expect(resolveHeartbeatSessionModels(undefined, runtimeConfig)).toEqual({
      defaultProvider: "anthropic",
      defaultModelId: "claude-opus-4",
      fallbackProvider: undefined,
      fallbackModelId: undefined,
    });
    expect(resolveValidatorSessionModel(undefined, undefined, undefined, runtimeConfig)).toEqual({
      provider: "anthropic",
      modelId: "claude-opus-4",
    });
    expect(resolveMergerSessionModel(undefined, runtimeConfig)).toEqual({
      provider: "anthropic",
      modelId: "claude-opus-4",
    });
  });

  it("covers backend-only surfaces; desktop and mobile breakpoints are not applicable", () => {
    expect(resolveExecutorSessionModel(undefined, undefined, settings, { model: "stale/old" })).toEqual({
      provider: "openai",
      modelId: "gpt-4.1",
    });
    expect(resolvePlanningSessionModel(undefined, undefined, settings, { model: "stale/old" })).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });
    expect(resolveValidatorSessionModel(undefined, undefined, settings, { model: "stale/old" })).toEqual({
      provider: "google",
      modelId: "gemini-2.5-pro",
    });
    expect(resolveMergerSessionModel(settings, { model: "stale/old" })).toEqual({
      provider: "google",
      modelId: "gemini-2.5-pro",
    });
  });
});

describe("createResolvedAgentSession", () => {
  beforeEach(() => {
    resolveRuntimeMock.mockReset();
  });

  it("forwards taskEnv unchanged to runtime session factory", async () => {
    const mockSession = { prompt: vi.fn() } as any;
    const createSessionMock = vi.fn().mockResolvedValue({
      session: mockSession,
      sessionFile: "session.json",
    });
    resolveRuntimeMock.mockResolvedValue({
      runtime: {
        id: "pi",
        name: "Default PI Runtime",
        createSession: createSessionMock,
        promptWithFallback: vi.fn(),
        describeModel: vi.fn(() => "mock/model"),
      },
      runtimeId: "pi",
      wasConfigured: false,
    });

    const { createResolvedAgentSession } = await import("../agent-session-helpers.js");

    const taskEnv = { PATH: "/tmp/bin", FUSION_TEST_VAR: "value" };
    await createResolvedAgentSession({
      sessionPurpose: "executor",
      pluginRunner: undefined,
      cwd: "/tmp/project",
      systemPrompt: "system",
      taskEnv,
    });

    expect(createSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        taskEnv,
      }),
    );
  });

  it("emits session:runtime-resolved when runAuditor is provided", async () => {
    const mockSession = { prompt: vi.fn() } as any;
    const createSessionMock = vi.fn().mockResolvedValue({ session: mockSession });
    const auditDatabaseMock = vi.fn().mockResolvedValue(undefined);

    const { createResolvedAgentSession } = await import("../agent-session-helpers.js");

    await createResolvedAgentSession({
      sessionPurpose: "executor",
      cwd: "/tmp/project",
      systemPrompt: "system",
      defaultProvider: "mock",
      defaultModelId: "mock-default",
      runAuditor: { database: auditDatabaseMock } as any,
      settings: { testMode: true } as any,
    });

    expect(createSessionMock).not.toHaveBeenCalled();
    expect(auditDatabaseMock).toHaveBeenCalledTimes(1);
    expect(auditDatabaseMock).toHaveBeenCalledWith({
      type: "session:runtime-resolved",
      target: "mock",
      metadata: {
        sessionPurpose: "executor",
        runtimeId: "mock",
        wasConfigured: true,
        provider: "mock",
        modelId: "mock-default",
        mockProviderActive: true,
        testModeActive: true,
      },
    });
  });

  it("succeeds when runAuditor is omitted", async () => {
    const mockSession = { prompt: vi.fn() } as any;
    const createSessionMock = vi.fn().mockResolvedValue({
      session: mockSession,
      sessionFile: "session.json",
    });
    resolveRuntimeMock.mockResolvedValue({
      runtime: {
        id: "pi",
        name: "Default PI Runtime",
        createSession: createSessionMock,
        promptWithFallback: vi.fn(),
        describeModel: vi.fn(() => "mock/model"),
      },
      runtimeId: "pi",
      wasConfigured: false,
    });

    const { createResolvedAgentSession } = await import("../agent-session-helpers.js");

    await expect(createResolvedAgentSession({
      sessionPurpose: "executor",
      cwd: "/tmp/project",
      systemPrompt: "system",
    })).resolves.toMatchObject({ runtimeId: "pi", wasConfigured: false });
  });

  it("warns and continues when runAuditor throws", async () => {
    const mockSession = { prompt: vi.fn() } as any;
    const createSessionMock = vi.fn().mockResolvedValue({ session: mockSession });
    resolveRuntimeMock.mockResolvedValue({
      runtime: {
        id: "pi",
        name: "Default PI Runtime",
        createSession: createSessionMock,
        promptWithFallback: vi.fn(),
        describeModel: vi.fn(() => "mock/model"),
      },
      runtimeId: "pi",
      wasConfigured: false,
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { createResolvedAgentSession } = await import("../agent-session-helpers.js");

    await expect(createResolvedAgentSession({
      sessionPurpose: "executor",
      cwd: "/tmp/project",
      systemPrompt: "system",
      runAuditor: {
        database: vi.fn().mockRejectedValue(new Error("audit down")),
      } as any,
    })).resolves.toMatchObject({ session: mockSession, runtimeId: "pi", wasConfigured: false });

    warnSpy.mockRestore();
  });
});

describe("resolveMergerSessionModel", () => {
  it("uses assigned agent runtime model only when no default model pair is configured", () => {
    expect(
      resolveMergerSessionModel(
        {},
        { model: "  anthropic/claude-3-5-sonnet-20241022  " },
      ),
    ).toEqual({
      provider: "anthropic",
      modelId: "claude-3-5-sonnet-20241022",
    });
  });

  it("falls back to default override pair when runtime model is not fully specified", () => {
    expect(
      resolveMergerSessionModel(
        {
          defaultProviderOverride: "openai",
          defaultModelIdOverride: "gpt-4.1",
          defaultProvider: "anthropic",
          defaultModelId: "claude-3-5-sonnet",
        },
        { modelProvider: "anthropic" },
      ),
    ).toEqual({
      provider: "openai",
      modelId: "gpt-4.1",
    });
  });

  it("falls back to global defaults when no override pair is configured", () => {
    expect(
      resolveMergerSessionModel(
        {
          defaultProvider: "anthropic",
          defaultModelId: "claude-3-5-sonnet",
        },
        { modelId: "claude-3-opus" },
      ),
    ).toEqual({
      provider: "anthropic",
      modelId: "claude-3-5-sonnet",
    });
  });

  it("ignores partial override pairs and falls back to global defaults", () => {
    expect(
      resolveMergerSessionModel({
        defaultProviderOverride: "openai",
        defaultProvider: "anthropic",
        defaultModelId: "claude-3-5-sonnet",
      }),
    ).toEqual({
      provider: "anthropic",
      modelId: "claude-3-5-sonnet",
    });

    expect(
      resolveMergerSessionModel({
        defaultModelIdOverride: "gpt-4.1",
        defaultProvider: "anthropic",
        defaultModelId: "claude-3-5-sonnet",
      }),
    ).toEqual({
      provider: "anthropic",
      modelId: "claude-3-5-sonnet",
    });
  });

  it("works when assignedAgentRuntimeConfig is undefined", () => {
    expect(
      resolveMergerSessionModel({
        defaultProviderOverride: "openai",
        defaultModelIdOverride: "gpt-4.1",
        defaultProvider: "anthropic",
        defaultModelId: "claude-3-5-sonnet",
      }),
    ).toEqual({
      provider: "openai",
      modelId: "gpt-4.1",
    });
  });
});
