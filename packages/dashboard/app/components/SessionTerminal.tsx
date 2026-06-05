import "./SessionTerminal.css";
import "@xterm/xterm/css/xterm.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Terminal as TerminalIcon, ShieldAlert, Settings, Eye } from "lucide-react";
import type { Terminal as XTerm, ITerminalAddon } from "@xterm/xterm";
import { appendTokenQuery } from "../auth";
import { api } from "../api";

/**
 * SessionTerminal (CLI Agent Executor, U11) — shared xterm terminal for a CLI
 * agent session. Lazy-loads xterm + fit/webgl/unicode11 addons (kept out of the
 * main bundle), bridges to the U10 WebSocket attach channel with ACK flow
 * control, and renders the posture chip / read-only badge / confirm-advance
 * strip / replay states described in the U11 visibility matrix.
 *
 * The WS bridge:
 *  1. POST /api/cli-sessions/:id/attach-ticket  → { ticket }
 *  2. open WS /api/cli-sessions/ws?sessionId=&ticket=  (fn_token carried on URL)
 *  3. base64 scrollback/data → term.write; term.onData → input frames
 *  4. fit + debounced ResizeObserver → resize frames
 *  5. ACK {type:"ack",bytes} via term.write callbacks (~32KB cadence)
 */

/** ACK cadence — ACK roughly every 32KB of consumed output. */
const ACK_THRESHOLD_BYTES = 32 * 1024;
const RESIZE_DEBOUNCE_MS = 100;

/** The posture surfaced on the session record (denormalized at launch, U15). */
export interface SessionTerminalPosture {
  /** Adapter display name (single Terminal icon for all adapters). */
  adapterName: string;
  /** Resolved autonomy mode label (e.g. "auto-approve", "default"). */
  mode?: string;
  /**
   * Whether the resolved argv+env elevates above the adapter baseline. When
   * true the chip renders in warning color with a shield naming the flag.
   */
  elevated?: boolean;
  /** The elevated flag(s), named on the chip / tooltip when elevated. */
  elevatedFlags?: string[];
  /** Resolved posture lines shown in the click tooltip. */
  resolved?: string[];
}

/** Replay/live mode for the terminal viewport. */
export type SessionTerminalMode = "live" | "idle" | "ended";

export interface SessionTerminalProps {
  sessionId: string;
  /** When true, term.onData is dropped (one-shot / replay sessions). */
  readOnly?: boolean;
  posture?: SessionTerminalPosture;
  /** Drives the replay header: live | "session idle" | "session ended". */
  mode?: SessionTerminalMode;
  projectId?: string;
  /** Generic-tier idle confirm-advance strip — POST confirm-advance on Advance. */
  onConfirmAdvance?: (decision: "advance" | "not-yet") => void | Promise<void>;
  /** Whether the confirm-advance strip is offered (generic-tier idle). */
  showConfirmAdvance?: boolean;
  /** Settings deep link for the posture chip tooltip. */
  onOpenAdapterSettings?: () => void;
}

interface AttachTicketResponse {
  ticket: string;
  expiresAt: string;
  readOnly: boolean;
}

/** Build the WS URL for the cli-sessions attach channel (mirrors useTerminal). */
function buildCliWsUrl(sessionId: string, ticket: string): string {
  if (typeof window === "undefined") return "";
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const base =
    `${protocol}//${window.location.host}/api/cli-sessions/ws` +
    `?sessionId=${encodeURIComponent(sessionId)}&ticket=${encodeURIComponent(ticket)}`;
  return appendTokenQuery(base);
}

function decodeBase64ToString(b64: string): string {
  if (typeof window !== "undefined" && typeof window.atob === "function") {
    // atob → binary string → UTF-8 decode.
    const binary = window.atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  }
  return Buffer.from(b64, "base64").toString("utf8");
}

export function SessionTerminal({
  sessionId,
  readOnly = false,
  posture,
  mode = "live",
  projectId,
  onConfirmAdvance,
  showConfirmAdvance = false,
  onOpenAdapterSettings,
}: SessionTerminalProps) {
  const { t } = useTranslation("app");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<ITerminalAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const [postureTooltipOpen, setPostureTooltipOpen] = useState(false);
  const [advanceDismissed, setAdvanceDismissed] = useState(false);
  const [advancePending, setAdvancePending] = useState(false);

  // Re-arm the strip whenever a fresh idle window is offered.
  useEffect(() => {
    if (showConfirmAdvance) setAdvanceDismissed(false);
  }, [showConfirmAdvance, sessionId]);

  // ── xterm lifecycle + WS bridge ──────────────────────────────────────────
  useEffect(() => {
    if (!sessionId || typeof window === "undefined") return;
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let unackedBytes = 0;

    const sendResize = (cols: number, rows: number) => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    };

    const ackBytes = (n: number) => {
      unackedBytes += n;
      if (unackedBytes < ACK_THRESHOLD_BYTES) return;
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ack", bytes: unackedBytes }));
      }
      unackedBytes = 0;
    };

    const init = async () => {
      // 1. Mint a single-use attach ticket via the app API helper.
      let ticketRes: AttachTicketResponse;
      try {
        ticketRes = await api<AttachTicketResponse>(
          `/cli-sessions/${encodeURIComponent(sessionId)}/attach-ticket`,
          { method: "POST", body: JSON.stringify(projectId ? { projectId } : {}) },
        );
      } catch {
        return; // surfaced via the "disconnected" state header below
      }
      if (disposed) return;

      // 2. Lazy-load xterm + addons (out of the main bundle).
      const [{ Terminal }, { FitAddon }, { Unicode11Addon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-unicode11"),
      ]);
      if (disposed || !containerRef.current) return;

      const term = new Terminal({
        convertEol: false,
        cursorBlink: !readOnly && mode === "live",
        disableStdin: readOnly,
        scrollback: 10000,
        // Defensive: do NOT register an OSC 52 (clipboard-write) handler. The
        // server-side neutralizer (U10) strips it; we add no client handling.
        fontFamily:
          'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
        fontSize: 13,
      });
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      const unicode11 = new Unicode11Addon();
      term.loadAddon(unicode11);
      term.unicode.activeVersion = "11";

      term.open(containerRef.current);
      xtermRef.current = term;
      fitAddonRef.current = fitAddon as unknown as ITerminalAddon;

      // WebGL renderer with context-loss fallback to the DOM renderer.
      try {
        const { WebglAddon } = await import("@xterm/addon-webgl");
        if (!disposed) {
          const webgl = new WebglAddon();
          webgl.onContextLoss(() => {
            try {
              webgl.dispose();
            } catch {
              /* fall back to DOM renderer */
            }
          });
          term.loadAddon(webgl);
        }
      } catch {
        /* WebGL unavailable — DOM renderer is the default fallback */
      }

      try {
        (fitAddon as unknown as { fit: () => void }).fit();
      } catch {
        /* container not measurable yet */
      }

      // term.onData → input frames (skip entirely when read-only).
      if (!readOnly) {
        term.onData((data: string) => {
          const ws = wsRef.current;
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "input", data }));
          }
        });
      }

      // Debounced ResizeObserver → resize frames.
      resizeObserver = new ResizeObserver(() => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          try {
            (fitAddon as unknown as { fit: () => void }).fit();
            sendResize(term.cols, term.rows);
          } catch {
            /* ignore transient measure failures */
          }
        }, RESIZE_DEBOUNCE_MS);
      });
      resizeObserver.observe(containerRef.current);

      // 3. Open the WS attach channel.
      const ws = new WebSocket(buildCliWsUrl(sessionId, ticketRes.ticket));
      wsRef.current = ws;

      ws.onopen = () => {
        sendResize(term.cols, term.rows);
      };

      ws.onmessage = (event) => {
        let msg: { type?: string; data?: string };
        try {
          msg = JSON.parse(typeof event.data === "string" ? event.data : "");
        } catch {
          return;
        }
        switch (msg.type) {
          case "scrollback":
          case "data": {
            if (typeof msg.data !== "string") return;
            const text = decodeBase64ToString(msg.data);
            const byteLen = text.length;
            // ACK once xterm has flushed the chunk to the screen.
            term.write(text, () => ackBytes(byteLen));
            break;
          }
          // state / error / exit frames are advisory; the SSE channel and the
          // mode prop drive header copy. We intentionally do not mutate the
          // viewport on them.
          default:
            break;
        }
      };
    };

    void init();

    return () => {
      disposed = true;
      if (resizeTimer) clearTimeout(resizeTimer);
      if (resizeObserver) resizeObserver.disconnect();
      const ws = wsRef.current;
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        try {
          ws.close();
        } catch {
          /* already closing */
        }
        wsRef.current = null;
      }
      const term = xtermRef.current;
      if (term) {
        try {
          term.dispose();
        } catch {
          /* ignore */
        }
        xtermRef.current = null;
      }
      fitAddonRef.current = null;
    };
  }, [sessionId, readOnly, mode, projectId]);

  const replayLabel = useMemo(() => {
    if (mode === "idle") return t("cliTerminal.replayIdle", "Session idle");
    if (mode === "ended") return t("cliTerminal.replayEnded", "Session ended");
    return null;
  }, [mode, t]);

  const handleAdvance = useCallback(async () => {
    if (!onConfirmAdvance) return;
    setAdvancePending(true);
    try {
      await onConfirmAdvance("advance");
      setAdvanceDismissed(true);
    } finally {
      setAdvancePending(false);
    }
  }, [onConfirmAdvance]);

  const handleNotYet = useCallback(async () => {
    if (onConfirmAdvance) await onConfirmAdvance("not-yet");
    // "Not yet" stays in execute and re-arms the idle timer (server-side); the
    // strip hides until the next idle window re-offers it.
    setAdvanceDismissed(true);
  }, [onConfirmAdvance]);

  const elevated = Boolean(posture?.elevated);
  const flagSummary = posture?.elevatedFlags?.join(", ");

  return (
    <div className="cli-session-terminal" data-mode={mode} data-read-only={readOnly}>
      <header className="cli-session-terminal__header">
        {posture && (
          <div className="cli-session-terminal__posture-wrap">
            <button
              type="button"
              className={`cli-posture-chip${elevated ? " cli-posture-chip--elevated" : ""}`}
              data-elevated={elevated}
              aria-expanded={postureTooltipOpen}
              onClick={() => setPostureTooltipOpen((v) => !v)}
            >
              {elevated ? (
                <ShieldAlert size={13} aria-hidden="true" />
              ) : (
                <TerminalIcon size={13} aria-hidden="true" />
              )}
              <span className="cli-posture-chip__name">{posture.adapterName}</span>
              {posture.mode && (
                <span className="cli-posture-chip__mode">{posture.mode}</span>
              )}
              {elevated && flagSummary && (
                <span className="cli-posture-chip__flag">{flagSummary}</span>
              )}
            </button>
            {postureTooltipOpen && (
              <div className="cli-posture-tooltip" role="tooltip">
                <p className="cli-posture-tooltip__title">
                  {t("cliTerminal.postureResolved", "Resolved posture")}
                </p>
                <ul className="cli-posture-tooltip__list">
                  {(posture.resolved ?? []).map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                  {(posture.resolved ?? []).length === 0 && (
                    <li>{posture.mode ?? t("cliTerminal.postureBaseline", "Baseline")}</li>
                  )}
                </ul>
                {onOpenAdapterSettings && (
                  <button
                    type="button"
                    className="cli-posture-tooltip__settings"
                    onClick={() => {
                      setPostureTooltipOpen(false);
                      onOpenAdapterSettings();
                    }}
                  >
                    <Settings size={12} aria-hidden="true" />
                    {t("cliTerminal.adapterSettings", "Adapter settings")}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        {readOnly && (
          <span className="cli-session-terminal__readonly-badge">
            <Eye size={12} aria-hidden="true" />
            {t("cliTerminal.readOnly", "Read-only")}
          </span>
        )}
        {replayLabel && (
          <span className="cli-session-terminal__replay-badge" data-replay-mode={mode}>
            {replayLabel}
          </span>
        )}
      </header>

      <div
        className="cli-session-terminal__viewport"
        ref={containerRef}
        data-testid="cli-terminal-viewport"
      />

      {showConfirmAdvance && !advanceDismissed && (
        <div className="cli-session-terminal__advance-strip" role="region">
          <span className="cli-session-terminal__advance-copy">
            {t(
              "cliTerminal.advancePrompt",
              "This session looks idle — advance to review?",
            )}
          </span>
          <div className="cli-session-terminal__advance-actions">
            <button
              type="button"
              className="cli-session-terminal__advance-btn"
              disabled={advancePending}
              onClick={handleAdvance}
            >
              {t("cliTerminal.advance", "Advance")}
            </button>
            <button
              type="button"
              className="cli-session-terminal__advance-btn cli-session-terminal__advance-btn--secondary"
              disabled={advancePending}
              onClick={handleNotYet}
            >
              {t("cliTerminal.notYet", "Not yet")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
