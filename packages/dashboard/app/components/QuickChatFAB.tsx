import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { MessageSquare, Send, X } from "lucide-react";
import type { Agent } from "../api";
import { useQuickChat, type ChatMessageInfo } from "../hooks/useQuickChat";
import { useAgents } from "../hooks/useAgents";

interface QuickChatFABProps {
  projectId?: string;
  addToast: (msg: string, type?: "success" | "error") => void;
  /** When false, the FAB button is hidden but the panel can still be opened programmatically via the open prop */
  showFAB?: boolean;
  /** When true, the chat panel is open */
  open?: boolean;
  /** Callback when the panel should be opened/closed */
  onOpenChange?: (open: boolean) => void;
}

function getAgentLabel(agent: Agent): string {
  const base = agent.name?.trim() || agent.id;
  return `${base} (${agent.role})`;
}

/** Position type for FAB positioning (right and bottom offsets from viewport edges) */
interface Position {
  x: number;
  y: number;
}

/**
 * Custom hook for draggable behavior.
 * Positions are stored as right/bottom offsets (matching the current positioning model).
 * Position persists in localStorage keyed per-project.
 * @param projectId - Optional project ID for localStorage key
 * @param externalDidDragRef - External ref to track drag state for click detection
 */
function useDraggable(projectId?: string, externalDidDragRef?: React.MutableRefObject<boolean>) {
  // Get executor footer height from CSS variable
  const getFooterHeight = useCallback((): number => {
    if (typeof window === "undefined") return 0;
    const height = getComputedStyle(document.documentElement)
      .getPropertyValue("--executor-footer-height")
      .trim();
    return height ? parseFloat(height) || 0 : 0;
  }, []);

  // Default positions
  const getDefaultPosition = useCallback((): Position => {
    // Mobile uses tighter default offset (4px vs 24px) to maximize screen space
    if (typeof window !== "undefined" && window.innerWidth <= 768) {
      return { x: 4, y: 4 + getFooterHeight() };
    }
    return { x: 24, y: 24 + getFooterHeight() };
  }, [getFooterHeight]);

  // Load position from localStorage on mount
  const [position, setPosition] = useState<Position>(() => {
    if (typeof window === "undefined") return getDefaultPosition();

    const storageKey = `fusion-quick-chat-position-${projectId || "default"}`;
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const parsed = JSON.parse(saved) as Position;
        // Validate the parsed position has valid numbers
        if (typeof parsed.x === "number" && typeof parsed.y === "number" && !isNaN(parsed.x) && !isNaN(parsed.y)) {
          return parsed;
        }
      }
    } catch {
      // Ignore parse errors, fall back to default
    }
    return getDefaultPosition();
  });

  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number; pointerX: number; pointerY: number } | null>(null);
  // Use external ref if provided, otherwise create internal one
  const didDragRef = externalDidDragRef ?? useRef(false);

  // Clamp position to keep FAB within viewport
  const clampPosition = useCallback((pos: Position): Position => {
    if (typeof window === "undefined") return pos;

    const fabSize = 48; // FAB is 48x48px
    // Mobile uses tighter margin (4px) to maximize screen space on small devices
    const edgeMargin = window.innerWidth <= 768 ? 4 : 48;
    // Account for mobile nav height when clamping bottom
    const mobileNavHeight = window.innerWidth <= 768 ? 44 : 0;
    // Account for executor footer height on desktop
    const footerHeight = window.innerWidth > 768 ? getFooterHeight() : 0;

    const maxX = window.innerWidth - fabSize - edgeMargin;
    const maxY = window.innerHeight - fabSize - edgeMargin - mobileNavHeight - footerHeight;

    return {
      x: Math.max(edgeMargin, Math.min(maxX, pos.x)),
      y: Math.max(edgeMargin, Math.min(maxY, pos.y)),
    };
  }, [getFooterHeight]);

  // Persist position to localStorage
  const savePosition = useCallback((pos: Position) => {
    if (typeof window === "undefined") return;

    const storageKey = `fusion-quick-chat-position-${projectId || "default"}`;
    try {
      localStorage.setItem(storageKey, JSON.stringify(pos));
    } catch {
      // Ignore storage errors
    }
  }, [projectId]);

  // Handle pointer down (start drag)
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    // Only handle primary button (left click) or touch
    if (e.button !== 0 && e.pointerType === "mouse") return;

    // Check if this is a click on an interactive element inside the FAB (not the FAB itself)
    const target = e.target as HTMLElement;
    const fabButton = target.closest(".quick-chat-fab") as HTMLElement | null;
    if (!fabButton) return;

    e.preventDefault();
    // setPointerCapture may not exist in jsdom/tests
    if (typeof fabButton.setPointerCapture === "function") {
      fabButton.setPointerCapture(e.pointerId);
    }

    dragStartRef.current = {
      x: position.x,
      y: position.y,
      pointerX: e.clientX,
      pointerY: e.clientY,
    };
    didDragRef.current = false;
    setIsDragging(true);

    // Prevent text selection during drag
    document.body.style.userSelect = "none";
  }, [position]);

  // Handle pointer move (during drag)
  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragStartRef.current || !isDragging) return;

    const deltaX = e.clientX - dragStartRef.current.pointerX;
    const deltaY = e.clientY - dragStartRef.current.pointerY;

    // Check if we've moved enough to be considered a drag (>= 5px)
    if (Math.abs(deltaX) >= 5 || Math.abs(deltaY) >= 5) {
      didDragRef.current = true;
    }

    if (didDragRef.current) {
      // Move in the opposite direction (dragging right moves FAB right, which means reducing right offset)
      const newX = dragStartRef.current.x - deltaX;
      const newY = dragStartRef.current.y - deltaY;

      const clamped = clampPosition({ x: newX, y: newY });
      setPosition(clamped);
    }
  }, [isDragging, clampPosition]);

  // Handle pointer up (end drag)
  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragStartRef.current) return;

    const fabButton = (e.target as HTMLElement).closest(".quick-chat-fab") as HTMLElement | null;
    if (fabButton && typeof fabButton.releasePointerCapture === "function") {
      fabButton.releasePointerCapture(e.pointerId);
    }

    setIsDragging(false);

    // Restore text selection
    document.body.style.userSelect = "";

    // If we didn't drag (movement < 5px), this was a click - caller handles toggle
    if (!didDragRef.current) {
      dragStartRef.current = null;
      return;
    }

    // Save position to localStorage
    savePosition(position);

    dragStartRef.current = null;
    didDragRef.current = false;
  }, [position, savePosition]);

  return {
    position,
    isDragging,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
  };
}

export function QuickChatFAB({ projectId, addToast, showFAB = true, open, onOpenChange }: QuickChatFABProps) {
  const { agents } = useAgents(projectId);
  // Internal state for uncontrolled mode, controlled state when open prop is provided
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = open !== undefined;
  const isOpen = isControlled ? open : internalOpen;
  const setIsOpen = isControlled
    ? (value: boolean | ((prev: boolean) => boolean)) => {
        if (typeof value === "function") {
          onOpenChange?.(value(isOpen));
        } else {
          onOpenChange?.(value);
        }
      }
    : setInternalOpen;
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [messageInput, setMessageInput] = useState("");

  // Track if we just finished a drag (to prevent click from firing after drag)
  const didDragRef = useRef(false);

  // Draggable hook for FAB positioning
  const {
    position,
    isDragging,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
  } = useDraggable(projectId, didDragRef);

  // Chat session hook
  const {
    messages,
    isStreaming,
    streamingText,
    streamingThinking,
    sessionsLoading,
    messagesLoading,
    sendMessage,
    switchSession,
  } = useQuickChat(projectId, addToast);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const fabRef = useRef<HTMLButtonElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);

  // Track the previous agent ID to detect changes
  const prevAgentIdRef = useRef<string>("");

  useEffect(() => {
    if (agents.length === 0) {
      setSelectedAgentId("");
      return;
    }

    const selectedStillExists = agents.some((agent) => agent.id === selectedAgentId);
    if (!selectedStillExists) {
      setSelectedAgentId(agents[0]?.id ?? "");
    }
  }, [agents, selectedAgentId]);

  // Initialize session when an agent is selected and panel opens
  useEffect(() => {
    if (!isOpen || !selectedAgentId) return;
    if (selectedAgentId !== prevAgentIdRef.current) {
      prevAgentIdRef.current = selectedAgentId;
      void switchSession(selectedAgentId);
    }
  }, [isOpen, selectedAgentId, switchSession]);

  // Handle agent selector changes
  const handleAgentChange = useCallback(
    (agentId: string) => {
      setSelectedAgentId(agentId);
      prevAgentIdRef.current = agentId;
      void switchSession(agentId);
    },
    [switchSession],
  );

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) ?? null,
    [agents, selectedAgentId],
  );

  // Click outside and escape handling
  useEffect(() => {
    if (!isOpen) return;

    const handleDocumentClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (fabRef.current?.contains(target)) return;
      setIsOpen(false);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleDocumentClick);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handleDocumentClick);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen]);

  // Auto-scroll messages
  useEffect(() => {
    if (!isOpen) return;
    const messagesEl = messagesRef.current;
    if (!messagesEl) return;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }, [messages, streamingText, streamingThinking, isOpen]);

  const handleSendMessage = useCallback(async () => {
    const trimmed = messageInput.trim();
    if (!selectedAgentId || !trimmed || isStreaming) return;

    setMessageInput("");
    await sendMessage(trimmed);
  }, [sendMessage, isStreaming, messageInput, selectedAgentId]);

  const handleInputKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    void handleSendMessage();
  }, [handleSendMessage]);

  // Handle FAB click - only toggle if this was a click (not a drag)
  // Reset didDragRef after checking to prevent double-toggle
  const handleFABClick = useCallback(() => {
    if (didDragRef.current) {
      // Was a drag, don't toggle
      didDragRef.current = false;
      return;
    }
    setIsOpen((prev) => !prev);
  }, []);

  if (agents.length === 0) {
    return null;
  }

  // Calculate panel position: 60px above the FAB (FAB is 48px tall + 12px gap)
  const panelY = position.y + 60;

  return (
    <>
      {showFAB && (
        <button
          ref={fabRef}
          type="button"
          className="quick-chat-fab"
          aria-label="Open quick chat"
          data-testid="quick-chat-fab"
          data-dragging={isDragging ? "true" : "false"}
          style={{ right: position.x, bottom: position.y }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onClick={handleFABClick}
        >
          <MessageSquare size={24} />
        </button>
      )}

      {isOpen && (
        <div
          className="quick-chat-panel"
          ref={panelRef}
          data-testid="quick-chat-panel"
          style={{ right: position.x, bottom: panelY }}
        >
          <div className="quick-chat-panel-header">
            <h3>Quick Chat</h3>
            <button
              type="button"
              className="btn-icon"
              aria-label="Close quick chat"
              data-testid="quick-chat-close"
              onClick={() => setIsOpen(false)}
            >
              <X size={16} />
            </button>
          </div>

          <div className="quick-chat-panel-agent-select">
            <label htmlFor="quick-chat-agent-select" className="visually-hidden">Select agent</label>
            <select
              id="quick-chat-agent-select"
              value={selectedAgentId}
              onChange={(event) => handleAgentChange(event.target.value)}
              data-testid="quick-chat-agent-select"
            >
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {getAgentLabel(agent)}
                </option>
              ))}
            </select>
          </div>

          <div className="quick-chat-panel-messages" ref={messagesRef} data-testid="quick-chat-messages">
            {sessionsLoading || messagesLoading ? (
              <div className="quick-chat-panel-empty">Loading conversation…</div>
            ) : messages.length === 0 && !streamingText && !streamingThinking ? (
              <div className="quick-chat-panel-empty">No messages yet. Start the conversation!</div>
            ) : (
              <>
                {messages.map((message: ChatMessageInfo) => {
                  const isSent = message.role === "user";
                  return (
                    <div
                      key={message.id}
                      className={`quick-chat-panel-message ${isSent ? "quick-chat-panel-message--sent" : "quick-chat-panel-message--received"}`}
                      data-testid={`quick-chat-message-${message.id}`}
                    >
                      <p>{message.content}</p>
                    </div>
                  );
                })}
                {/* Streaming message bubble */}
                {(streamingText || streamingThinking) && (
                  <div
                    className="quick-chat-panel-message quick-chat-panel-message--received quick-chat-panel-message--streaming"
                    data-testid="quick-chat-streaming-message"
                  >
                    {streamingThinking && (
                      <p className="quick-chat-panel-thinking" data-testid="quick-chat-streaming-thinking">
                        {streamingThinking}
                      </p>
                    )}
                    {streamingText && (
                      <p data-testid="quick-chat-streaming-text">{streamingText}</p>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="quick-chat-panel-input">
            <input
              type="text"
              value={messageInput}
              onChange={(event) => setMessageInput(event.target.value)}
              onKeyDown={handleInputKeyDown}
              placeholder={selectedAgent ? `Message ${selectedAgent.name || selectedAgent.id}` : "Type a message"}
              disabled={!selectedAgentId || isStreaming}
              data-testid="quick-chat-input"
            />
            <button
              type="button"
              onClick={() => void handleSendMessage()}
              disabled={!selectedAgentId || messageInput.trim().length === 0 || isStreaming}
              data-testid="quick-chat-send"
            >
              <Send size={16} />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
