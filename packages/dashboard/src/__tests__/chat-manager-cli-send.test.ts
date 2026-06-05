/**
 * ChatManager.sendMessage cli-agent send-branch (CLI Agent Executor integration).
 *
 * When a chat session selects a cli-agent executor (`cliExecutorAdapterId`),
 * sendMessage must broker the composer text to the injected CliChatSessionRunner
 * (ensureSession + send) rather than running the model agent loop. Narrow fakes:
 * no real ChatStore, no pi-ai agent, no PTY, no network, no port 4040.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChatManager } from "../chat.js";

const mockChatStore = {
  getSession: vi.fn(),
  createSession: vi.fn(),
  addMessage: vi.fn(),
  getMessages: vi.fn(),
  updateSession: vi.fn(),
  setCliSessionFile: vi.fn(),
  setInFlightGeneration: vi.fn(),
  getRoomMessages: vi.fn(),
};

function makeManager(): ChatManager {
  return new ChatManager(mockChatStore as never, "/tmp/test");
}

describe("ChatManager.sendMessage — cli-agent send branch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes a cli-executor chat session's composer send to runner.send", async () => {
    mockChatStore.getSession.mockReturnValue({
      id: "chat-cli",
      cliExecutorAdapterId: "claude-code",
      projectId: "proj-1",
    });

    const ensureSession = vi.fn(async () => "cli-session-1");
    const send = vi.fn(async () => "sent" as const);
    const manager = makeManager();
    manager.setCliChatRunner({ ensureSession, send }, "proj-1");

    await manager.sendMessage("chat-cli", "hello agent");

    expect(ensureSession).toHaveBeenCalledWith("chat-cli", { projectId: "proj-1" });
    expect(send).toHaveBeenCalledWith("chat-cli", "hello agent");
    // The model-agent path persists in-flight generation state; the cli branch
    // must NOT touch it.
    expect(mockChatStore.setInFlightGeneration).not.toHaveBeenCalled();
  });

  it("uses the session's projectId when no explicit runner projectId is set", async () => {
    mockChatStore.getSession.mockReturnValue({
      id: "chat-cli2",
      cliExecutorAdapterId: "codex",
      projectId: "proj-from-session",
    });
    const ensureSession = vi.fn(async () => "cli-session-2");
    const send = vi.fn(async () => "queued" as const);
    const manager = makeManager();
    // No projectId passed to setCliChatRunner → falls back to session.projectId.
    manager.setCliChatRunner({ ensureSession, send });

    await manager.sendMessage("chat-cli2", "queued please");

    expect(ensureSession).toHaveBeenCalledWith("chat-cli2", { projectId: "proj-from-session" });
    expect(send).toHaveBeenCalledWith("chat-cli2", "queued please");
  });
});
