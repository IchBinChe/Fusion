// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const { createFnAgentMock, resolveMcpServersForStoreMock } = vi.hoisted(() => ({
  createFnAgentMock: vi.fn(async () => ({
    session: {
      state: { messages: [] as Array<{ role: string; content: string }> },
      prompt: vi.fn(async function (this: { state: { messages: Array<{ role: string; content: string }> } }, _message: string) {
        this.state.messages.push({
          role: "assistant",
          content: JSON.stringify({
            type: "question",
            data: {
              id: "q1",
              text: "What should be built?",
              type: "text",
              required: true,
            },
          }),
        });
      }),
      dispose: vi.fn(),
    },
  })),
  resolveMcpServersForStoreMock: vi.fn(async () => ({
    servers: [{ name: "docs", transport: "stdio", command: "node", env: { TOKEN: "materialized-secret" } }],
    errors: [],
  })),
}));

vi.mock("@fusion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/core")>();
  return {
    ...actual,
    DEFAULT_TASK_PRIORITY: "normal",
    TASK_PRIORITIES: ["low", "normal", "high", "urgent"],
    resolvePrompt: vi.fn(() => undefined),
    summarizeTitle: vi.fn((value: string) => value.slice(0, 80)),
  };
});

vi.mock("@fusion/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/engine")>();
  return {
    ...actual,
    buildSessionSkillContextSync: vi.fn(() => ({ skillSelectionContext: undefined })),
    createChatTaskDocumentTools: vi.fn(() => []),
    createWorkflowAuthoringTools: vi.fn(() => []),
    createFnAgent: createFnAgentMock,
    resolveMcpServersForStore: resolveMcpServersForStoreMock,
  };
});

vi.mock("../planning-board-tools.js", () => ({
  createPlanningBoardTools: vi.fn(() => []),
}));

import { __resetPlanningState, createSession } from "../planning.js";

describe("dashboard MCP lane forwarding", () => {
  beforeEach(() => {
    __resetPlanningState();
    createFnAgentMock.mockClear();
    resolveMcpServersForStoreMock.mockClear();
  });

  it("forwards the materialized MCP set to chat/planning createFnAgent sessions", async () => {
    const store = {} as never;

    await createSession("127.0.0.1", "Build a feature", store, "/tmp/fusion-dashboard-test");

    expect(resolveMcpServersForStoreMock).toHaveBeenCalledWith(store);
    expect(createFnAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/tmp/fusion-dashboard-test",
      mcpServers: [expect.objectContaining({ name: "docs", env: { TOKEN: "materialized-secret" } })],
    }));
  });
});
