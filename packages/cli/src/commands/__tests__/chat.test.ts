import { PassThrough, Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetAgent,
  mockGetConversation,
  mockGetInbox,
  mockSendMessage,
  mockMarkAsRead,
  mockClose,
  mockCleanup,
} = vi.hoisted(() => ({
  mockGetAgent: vi.fn(),
  mockGetConversation: vi.fn(),
  mockGetInbox: vi.fn(),
  mockSendMessage: vi.fn(),
  mockMarkAsRead: vi.fn(),
  mockClose: vi.fn(),
  mockCleanup: vi.fn(),
}));

vi.mock("@fusion/core", () => ({
  AgentStore: vi.fn(function () {
    return { init: vi.fn(), getAgent: mockGetAgent, close: mockClose };
  }),
  MessageStore: vi.fn(function () {
    return {
      getConversation: mockGetConversation,
      getInbox: mockGetInbox,
      sendMessage: mockSendMessage,
      markAsRead: mockMarkAsRead,
    };
  }),
}));

vi.mock("../../project-context.js", () => ({
  resolveAgentStoreBase: vi.fn().mockResolvedValue({
    rootDir: "/tmp/fusion-cli-chat-test",
    asyncLayer: {},
    cleanup: mockCleanup,
  }),
}));

import { runChatInteractive } from "../chat.js";
import { runMessageSend } from "../message.js";

function outputBuffer(): { output: PassThrough; read: () => string } {
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk));
  return { output, read: () => Buffer.concat(chunks).toString("utf8") };
}

describe("runChatInteractive mailbox conversation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAgent.mockResolvedValue({ id: "agent-001" });
    mockGetConversation.mockResolvedValue([]);
    mockGetInbox.mockResolvedValue([]);
    mockSendMessage.mockResolvedValue({ id: "msg-001" });
    mockCleanup.mockResolvedValue(undefined);
  });

  it("stamps sequential default sends with one stable cli-chat conversation id", async () => {
    for (const content of ["first", "second"]) {
      await runChatInteractive("agent-001", {
        once: true,
        nonInteractive: true,
        input: Readable.from(content),
        output: outputBuffer().output,
        replyTimeoutMs: 0,
      });
    }

    expect(mockSendMessage).toHaveBeenCalledTimes(2);
    const metadata = mockSendMessage.mock.calls.map(([input]) => input.metadata);
    expect(metadata).toEqual([
      { wakeRecipient: true, kind: "cli-chat", conversationId: "cli-chat:cli:agent-001" },
      { wakeRecipient: true, kind: "cli-chat", conversationId: "cli-chat:cli:agent-001" },
    ]);
  });

  it("renders only history from its conversation id or replies to its messages", async () => {
    mockGetConversation.mockResolvedValue([
      { id: "other", fromId: "agent-001", fromType: "agent", content: "other thread", type: "agent-to-user", read: false, createdAt: "2026-07-20T00:00:00.000Z", updatedAt: "2026-07-20T00:00:00.000Z", metadata: { conversationId: "other-thread" } },
      { id: "thread-message", fromId: "user:cli", fromType: "user", content: "thread start", type: "user-to-agent", read: true, createdAt: "2026-07-20T00:00:01.000Z", updatedAt: "2026-07-20T00:00:01.000Z", metadata: { conversationId: "custom-thread" } },
      { id: "thread-reply", fromId: "agent-001", fromType: "agent", content: "thread reply", type: "agent-to-user", read: false, createdAt: "2026-07-20T00:00:02.000Z", updatedAt: "2026-07-20T00:00:02.000Z", metadata: { replyTo: { messageId: "thread-message" } } },
    ]);
    const buffer = outputBuffer();

    await runChatInteractive("agent-001", {
      once: true,
      nonInteractive: true,
      input: Readable.from(""),
      output: buffer.output,
      conversationId: "custom-thread",
    });

    expect(buffer.read()).toContain("thread start");
    expect(buffer.read()).toContain("thread reply");
    expect(buffer.read()).not.toContain("other thread");
  });

  it("renders only replies associated with the current conversation and leaves other mail unread", async () => {
    mockGetInbox.mockResolvedValue([
      { id: "unrelated", fromId: "agent-001", fromType: "agent", content: "unrelated", type: "agent-to-user", read: false, createdAt: "2026-07-20T00:00:00.000Z", updatedAt: "2026-07-20T00:00:00.000Z" },
      { id: "reply", fromId: "agent-001", fromType: "agent", content: "associated", type: "agent-to-user", read: false, createdAt: "2026-07-20T00:00:01.000Z", updatedAt: "2026-07-20T00:00:01.000Z", metadata: { replyTo: { messageId: "msg-001" } } },
    ]);
    const buffer = outputBuffer();

    await runChatInteractive("agent-001", {
      once: true,
      nonInteractive: true,
      input: Readable.from("hello"),
      output: buffer.output,
      replyTimeoutMs: 5,
      pollIntervalMs: 1,
    });

    expect(buffer.read()).toContain("associated");
    expect(buffer.read()).not.toContain("unrelated");
    expect(mockMarkAsRead).toHaveBeenCalledWith("reply");
    expect(mockMarkAsRead).not.toHaveBeenCalledWith("unrelated");
  });

  it("uses an explicit conversation id and names inbox delivery in the session banner", async () => {
    const buffer = outputBuffer();
    await runChatInteractive("agent-001", {
      once: true,
      nonInteractive: true,
      input: Readable.from("hello"),
      output: buffer.output,
      conversationId: "custom-thread",
      replyTimeoutMs: 0,
    });

    expect(mockSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      metadata: { wakeRecipient: true, kind: "cli-chat", conversationId: "custom-thread" },
    }));
    expect(buffer.read()).toContain("Mailbox conversation");
    expect(buffer.read()).toContain("agent inbox");
    expect(buffer.read()).toContain("conversation-id: custom-thread");
  });

  it("explains mailbox delivery and the conversation id in REPL help", async () => {
    const buffer = outputBuffer();
    await runChatInteractive("agent-001", {
      input: Readable.from("/help\n/exit\n"),
      output: buffer.output,
      pollIntervalMs: 1,
    });

    expect(buffer.read()).toContain("Mailbox delivery to the agent inbox");
    expect(buffer.read()).toContain("conversation-id: cli-chat:cli:agent-001");
  });

  it("keeps fn message send as an unstamped one-shot message", async () => {
    await runMessageSend("agent-001", "ordinary mail");

    expect(mockSendMessage).toHaveBeenCalledWith(expect.not.objectContaining({ metadata: expect.anything() }));
  });
});
