import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ChatView } from "../ChatView";
import { loadAllAppCss } from "../../test/cssFixture";
import * as useChatModule from "../../hooks/useChat";
import * as useChatRoomsModule from "../../hooks/useChatRooms";
import type { ChatMessageInfo, ChatSessionInfo, UseChatReturn } from "../../hooks/useChat";
import type { UseChatRoomsResult } from "../../hooks/useChatRooms";
import { _resetInitialViewportHeight } from "../../hooks/useMobileKeyboard";

Element.prototype.scrollIntoView = vi.fn();

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return {
    ...actual,
    useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
  };
});
vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    fetchAgents: vi.fn().mockResolvedValue([]),
    fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
    fetchTasks: vi.fn().mockResolvedValue([]),
    searchFiles: vi.fn().mockResolvedValue({ files: [] }),
  };
});

const mockUseChat = vi.mocked(useChatModule.useChat);
const mockUseChatRooms = vi.mocked(useChatRoomsModule.useChatRooms);
const css = loadAllAppCss();

const activeSession: ChatSessionInfo = {
  id: "session-001",
  agentId: "agent-001",
  status: "active",
  title: "Mobile chat",
  createdAt: "2026-06-03T00:00:00.000Z",
  updatedAt: "2026-06-03T00:00:00.000Z",
};

const messageFixture: ChatMessageInfo = {
  id: "msg-001",
  sessionId: activeSession.id,
  role: "assistant",
  content: "Hello from Fusion",
  createdAt: "2026-06-03T00:00:00.000Z",
};

const defaultChatState: UseChatReturn = {
  sessions: [],
  activeSession: null,
  sessionsLoading: false,
  messages: [],
  messagesLoading: false,
  isStreaming: false,
  streamingText: "",
  streamingThinking: "",
  streamingToolCalls: [],
  selectSession: vi.fn(),
  createSession: vi.fn(),
  archiveSession: vi.fn(),
  deleteSession: vi.fn(),
  sendMessage: vi.fn(),
  stopStreaming: vi.fn(),
  pendingMessage: "",
  clearPendingMessage: vi.fn(),
  loadMoreMessages: vi.fn(),
  hasMoreMessages: false,
  searchQuery: "",
  setSearchQuery: vi.fn(),
  filteredSessions: [],
  refreshSessions: vi.fn(),
  agentsMap: new Map([["agent-001", { id: "agent-001", name: "Alpha" }]]),
};

const defaultRoomsState: UseChatRoomsResult = {
  rooms: [],
  roomsLoading: false,
  roomsError: null,
  activeRoom: null,
  activeRoomMembers: [],
  messages: [],
  messagesLoading: false,
  selectRoom: vi.fn(),
  createRoom: vi.fn(),
  deleteRoom: vi.fn(),
  sendRoomMessage: vi.fn().mockResolvedValue(undefined),
  refreshRooms: vi.fn(),
};

function ensureMatchMedia() {
  if (window.matchMedia) {
    return;
  }
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn(),
  });
}

function mockViewportMode(mode: "mobile" | "desktop") {
  ensureMatchMedia();
  const isMobile = mode === "mobile";
  Object.defineProperty(window, "innerWidth", { value: isMobile ? 375 : 1280, configurable: true });
  return vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: (isMobile && query === "(max-width: 768px)") || query === "(max-width: 768px), (max-height: 480px)",
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

async function renderWithCss(ui: JSX.Element) {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  let rendered = null;
  await act(async () => {
    rendered = render(ui);
  });
  return rendered;
}

function setupChat(overrides: Partial<UseChatReturn> = {}) {
  mockUseChat.mockReturnValue({ ...defaultChatState, ...overrides });
}

function setupRooms(overrides: Partial<UseChatRoomsResult> = {}) {
  mockUseChatRooms.mockReturnValue({ ...defaultRoomsState, ...overrides });
}

describe("FN-5948 mobile chat message pane rendering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.head.innerHTML = "";
    localStorage.clear();
    _resetInitialViewportHeight();
    setupChat();
    setupRooms();
  });

  it("keeps the regular mobile empty message pane centered and framed while preserving other direct-thread states", async () => {
    const restoreMatchMedia = mockViewportMode("mobile");
    try {
      setupChat({
        sessions: [activeSession],
        filteredSessions: [activeSession],
        activeSession,
      });

      await renderWithCss(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const emptyState = screen.getByText("No messages yet. Start the conversation!").closest(".chat-empty-state");
      expect(emptyState).toBeTruthy();
      expect(getComputedStyle(emptyState as HTMLElement).display).toBe("flex");
      expect(getComputedStyle(emptyState as HTMLElement).justifyContent).toBe("center");
      expect(getComputedStyle(emptyState as HTMLElement).textAlign).toBe("center");
      expect(css).toMatch(/\.chat-messages\s*>\s*\.chat-empty-state\s*\{[\s\S]*border:\s*1px solid var\(--border\);[\s\S]*background:\s*var\(--surface\);/);

      cleanup();
      document.head.innerHTML = "";
      setupChat({
        sessions: [activeSession],
        filteredSessions: [activeSession],
        activeSession,
        messagesLoading: true,
      });
      await renderWithCss(<ChatView projectId="proj-123" addToast={vi.fn()} />);
      expect(screen.getByText("Loading messages...")).toBeInTheDocument();

      cleanup();
      document.head.innerHTML = "";
      setupChat({
        sessions: [activeSession],
        filteredSessions: [activeSession],
        activeSession,
        messages: [messageFixture],
      });
      await renderWithCss(<ChatView projectId="proj-123" addToast={vi.fn()} />);
      expect(screen.getByText("Hello from Fusion")).toBeInTheDocument();

      cleanup();
      document.head.innerHTML = "";
      setupChat({
        sessions: [activeSession],
        filteredSessions: [activeSession],
        activeSession,
        isStreaming: true,
        streamingText: "Streaming reply",
      });
      await renderWithCss(<ChatView projectId="proj-123" addToast={vi.fn()} />);
      expect(screen.getByText("Streaming reply")).toBeInTheDocument();
      expect(screen.queryByText("No messages yet. Start the conversation!")).toBeNull();
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("keeps the rooms mobile empty pane centered and framed while preserving room loading and populated states", async () => {
    const restoreMatchMedia = mockViewportMode("mobile");
    try {
      localStorage.setItem("fusion:chat-scope", "rooms");
      const activeRoom = {
        id: "room-001",
        projectId: "proj-123",
        slug: "eng",
        name: "eng",
        createdAt: "2026-06-03T00:00:00.000Z",
        updatedAt: "2026-06-03T00:00:00.000Z",
      };

      setupRooms({
        rooms: [activeRoom],
        activeRoom,
      });
      await renderWithCss(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

      const emptyState = screen.getByText("No messages yet. Start the conversation!").closest(".chat-empty-state");
      expect(emptyState).toBeTruthy();
      expect(getComputedStyle(emptyState as HTMLElement).display).toBe("flex");
      expect(getComputedStyle(emptyState as HTMLElement).justifyContent).toBe("center");
      expect(css).toMatch(/\.chat-messages\s*>\s*\.chat-empty-state\s*\{[\s\S]*border:\s*1px solid var\(--border\);[\s\S]*background:\s*var\(--surface\);/);

      cleanup();
      document.head.innerHTML = "";
      setupRooms({
        rooms: [activeRoom],
        activeRoom,
        messagesLoading: true,
      });
      await renderWithCss(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);
      expect(screen.getByText("Loading messages...")).toBeInTheDocument();

      cleanup();
      document.head.innerHTML = "";
      setupRooms({
        rooms: [activeRoom],
        activeRoom,
        messages: [{
          id: "room-msg-001",
          roomId: activeRoom.id,
          role: "assistant",
          content: "Room message",
          senderAgentId: "agent-001",
          attachments: [],
          metadata: null,
          mentions: [],
          createdAt: "2026-06-03T00:00:00.000Z",
        }],
      });
      await renderWithCss(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);
      expect(screen.getByText("Room message")).toBeInTheDocument();
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("preserves the desktop message-pane invariant and does not recenter sidebar padded empty states", async () => {
    const restoreMatchMedia = mockViewportMode("desktop");
    try {
      setupChat({
        sessions: [activeSession],
        filteredSessions: [activeSession],
        activeSession,
      });
      await renderWithCss(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const messagePaneEmptyState = screen.getByText("No messages yet. Start the conversation!").closest(".chat-empty-state");
      expect(messagePaneEmptyState).toBeTruthy();
      expect(getComputedStyle(messagePaneEmptyState as HTMLElement).display).toBe("flex");
      expect(getComputedStyle(messagePaneEmptyState as HTMLElement).justifyContent).toBe("center");
      expect(css).toMatch(/\.chat-messages\s*>\s*\.chat-empty-state\s*\{[\s\S]*border:\s*1px solid var\(--border\);[\s\S]*background:\s*var\(--surface\);/);

      cleanup();
      document.head.innerHTML = "";
      setupChat({
        sessionsLoading: true,
      });
      await renderWithCss(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const sidebarEmptyState = screen.getByText("Loading...").closest(".chat-empty-state");
      expect(sidebarEmptyState).toBeTruthy();
      expect(getComputedStyle(sidebarEmptyState as HTMLElement).display).toBe("block");
      expect(getComputedStyle(sidebarEmptyState as HTMLElement).textAlign).toBe("left");
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });
});
