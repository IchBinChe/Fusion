import type { TaskStore, AgentLogEntry, AgentRole } from "@fusion/core";
import { createLogger } from "./logger.js";

/** Default byte threshold before an automatic flush. */
const FLUSH_SIZE_BYTES = 1024;
/** Default timer interval (ms) for periodic flush of small writes. */
const FLUSH_INTERVAL_MS = 500;

/**
 * Produce a human-readable summary from tool arguments.
 * Returns the full argument value without truncation.
 * Returns `undefined` for unknown tools or when no meaningful arg is found.
 */
export function summarizeToolArgs(name: string, args?: Record<string, unknown>): string | undefined {
  if (!args) return undefined;
  const lowerName = name.toLowerCase();

  if (lowerName === "bash") {
    const cmd = args.command;
    if (typeof cmd === "string") return cmd;
  }

  if (lowerName === "read" || lowerName === "edit" || lowerName === "write") {
    const p = args.path;
    if (typeof p === "string") return p;
  }

  // Fallback: return first string-valued arg
  for (const val of Object.values(args)) {
    if (typeof val === "string") return val;
  }

  return undefined;
}

/**
 * Options for creating an {@link AgentLogger}.
 *
 * Two sink modes are supported:
 * 1. **Task-store mode** (original): provide `store` + `taskId`. Writes go to
 *    `store.appendAgentLog(taskId, ...)`.
 * 2. **Callback mode**: provide `appendLog`. Writes go to the callback instead.
 *    When both are provided, both sinks receive every entry.
 */
export interface AgentLoggerOptions {
  /** The task store used to persist agent log entries (task-store mode). */
  store?: TaskStore;
  /** The task ID this logger is associated with (task-store mode). */
  taskId?: string;
  /**
   * Optional alternative sink callback. When provided, every flushed entry is
   * forwarded here in addition to (or instead of) `store.appendAgentLog`.
   * Use this for run-scoped logging where there is no task.
   */
  appendLog?: (entry: AgentLogEntry) => Promise<void>;
  /** Which agent role is producing log entries (persisted on every entry). */
  agent?: AgentRole;
  /** Optional callback invoked alongside text logging (e.g. for SSE streaming). */
  onAgentText?: (taskId: string, delta: string) => void;
  /** Optional callback invoked alongside tool logging (e.g. for SSE streaming). */
  onAgentTool?: (taskId: string, toolName: string) => void;
  /** Byte threshold for automatic flush. Defaults to 1024. */
  flushSizeBytes?: number;
  /** Timer interval (ms) for periodic flush. Defaults to 500. */
  flushIntervalMs?: number;
}

/**
 * Buffers agent text output and flushes it to the task store periodically
 * or when a size threshold is reached. Also handles tool-start logging with
 * detailed argument summaries via {@link summarizeToolArgs}.
 *
 * Produces `onText` and `onToolStart` callbacks compatible with
 * `createFnAgent`'s `AgentOptions` interface.
 *
 * @example
 * ```ts
 * const logger = new AgentLogger({ store, taskId, onAgentText, onAgentTool });
 * const { session } = await createFnAgent({
 *   cwd: worktreePath,
 *   onText: logger.onText,
 *   onToolStart: logger.onToolStart,
 *   // ...
 * });
 * try {
 *   await session.prompt(prompt);
 * } finally {
 *   await logger.flush();
 *   session.dispose();
 * }
 * ```
 */
export class AgentLogger {
  private textBuffer = "";
  private thinkingBuffer = "";
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private thinkingFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly flushSizeBytes: number;
  private readonly flushIntervalMs: number;
  private readonly store?: TaskStore;
  private readonly taskId: string;
  private readonly appendLogCb?: (entry: AgentLogEntry) => Promise<void>;
  private readonly agent?: AgentRole;
  private readonly externalTextCb?: (taskId: string, delta: string) => void;
  private readonly externalToolCb?: (taskId: string, toolName: string) => void;
  private readonly log = createLogger("agent-logger");

  constructor(options: AgentLoggerOptions) {
    this.store = options.store;
    this.taskId = options.taskId ?? "";
    this.appendLogCb = options.appendLog;
    this.agent = options.agent;
    this.externalTextCb = options.onAgentText;
    this.externalToolCb = options.onAgentTool;
    this.flushSizeBytes = options.flushSizeBytes ?? FLUSH_SIZE_BYTES;
    this.flushIntervalMs = options.flushIntervalMs ?? FLUSH_INTERVAL_MS;

    // Bind callbacks so they can be passed directly as function references
    this.onText = this.onText.bind(this);
    this.onToolStart = this.onToolStart.bind(this);
    this.onThinking = this.onThinking.bind(this);
    this.onToolEnd = this.onToolEnd.bind(this);
  }

  /**
   * Callback for agent text deltas. Buffers text and flushes on size
   * threshold or after a timer interval. Compatible with `AgentOptions.onText`.
   */
  onText(delta: string): void {
    this.externalTextCb?.(this.taskId, delta);
    this.textBuffer += delta;
    if (this.textBuffer.length >= this.flushSizeBytes) {
      if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
      this.flushTextBuffer();
    } else {
      this.scheduleFlush();
    }
  }

  /**
   * Callback for thinking block deltas. Buffers and flushes thinking text
   * as `type: "thinking"` entries, using the same size/timer pattern as `onText`.
   */
  onThinking(delta: string): void {
    this.thinkingBuffer += delta;
    if (this.thinkingBuffer.length >= this.flushSizeBytes) {
      if (this.thinkingFlushTimer) { clearTimeout(this.thinkingFlushTimer); this.thinkingFlushTimer = null; }
      this.flushThinkingBuffer();
    } else {
      this.scheduleThinkingFlush();
    }
  }

  /**
   * Callback for tool invocation starts. Flushes pending text, then logs the
   * tool name with a detail summary. Compatible with `AgentOptions.onToolStart`.
   */
  onToolStart(name: string, args?: Record<string, unknown>): void {
    this.externalToolCb?.(this.taskId, name);
    // Flush any pending text/thinking before recording the tool entry
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    this.flushTextBuffer();
    if (this.thinkingFlushTimer) { clearTimeout(this.thinkingFlushTimer); this.thinkingFlushTimer = null; }
    this.flushThinkingBuffer();
    const detail = summarizeToolArgs(name, args);
    this.writeEntry(name, "tool", detail, `Failed to log tool start "${name}" for ${this.taskId}`);
  }

  /**
   * Callback for tool execution completion. Logs as `type: "tool_result"` on success
   * or `type: "tool_error"` on failure.
   *
   * @param name - The tool name
   * @param isError - Whether the tool execution resulted in an error
   * @param result - Optional result value (persisted in full)
   */
  onToolEnd(name: string, isError: boolean, result?: unknown): void {
    const type = isError ? "tool_error" : "tool_result";
    let detail: string | undefined;
    if (result !== undefined && result !== null) {
      detail = typeof result === "string" ? result : JSON.stringify(result);
    }
    this.writeEntry(name, type, detail, `Failed to log tool end "${name}" (${type}) for ${this.taskId}`);
  }

  /**
   * Flush any remaining buffered text/thinking and clear timers.
   * Call this in a `finally` block before disposing the agent session.
   */
  async flush(): Promise<void> {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (this.thinkingFlushTimer) { clearTimeout(this.thinkingFlushTimer); this.thinkingFlushTimer = null; }
    await this.flushTextBuffer();
    await this.flushThinkingBuffer();
  }

  // ── Internal helpers ───────────────────────────────────────────────

  /**
   * Write a single structured entry through whichever sink(s) are configured.
   * When both `store`+`taskId` and `appendLogCb` are set, both receive the entry.
   * When only `appendLogCb` is set (no store/taskId), only the callback is used.
   * @param storeWarnMsg - Warning message prefix used when the task-store write fails.
   */
  private writeEntry(text: string, type: AgentLogEntry["type"], detail: string | undefined, storeWarnMsg: string): void {
    const entry: AgentLogEntry = {
      timestamp: new Date().toISOString(),
      taskId: this.taskId,
      text,
      type,
      ...(detail !== undefined && { detail }),
      ...(this.agent !== undefined && { agent: this.agent }),
    };

    if (this.store && this.taskId) {
      this.store.appendAgentLog(this.taskId, text, type, detail, this.agent).catch((err) => {
        this.log.warn(`${storeWarnMsg}: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    if (this.appendLogCb) {
      this.appendLogCb(entry).catch((err) => {
        this.log.warn(`appendLog callback failed for entry (${type}): ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }

  private flushTextBuffer(): Promise<void> {
    if (this.textBuffer.length === 0) return Promise.resolve();
    const chunk = this.textBuffer;
    this.textBuffer = "";
    const entry: AgentLogEntry = {
      timestamp: new Date().toISOString(),
      taskId: this.taskId,
      text: chunk,
      type: "text",
      ...(this.agent !== undefined && { agent: this.agent }),
    };

    const promises: Promise<void>[] = [];

    if (this.store && this.taskId) {
      promises.push(
        this.store.appendAgentLog(this.taskId, chunk, "text", undefined, this.agent).catch((err) => {
          this.log.warn(`Failed to flush text buffer for ${this.taskId}: ${err instanceof Error ? err.message : String(err)}`);
        }),
      );
    }

    if (this.appendLogCb) {
      promises.push(
        this.appendLogCb(entry).catch((err) => {
          this.log.warn(`appendLog callback failed for text flush: ${err instanceof Error ? err.message : String(err)}`);
        }),
      );
    }

    return Promise.all(promises).then(() => undefined);
  }

  private flushThinkingBuffer(): Promise<void> {
    if (this.thinkingBuffer.length === 0) return Promise.resolve();
    const chunk = this.thinkingBuffer;
    this.thinkingBuffer = "";
    const entry: AgentLogEntry = {
      timestamp: new Date().toISOString(),
      taskId: this.taskId,
      text: chunk,
      type: "thinking",
      ...(this.agent !== undefined && { agent: this.agent }),
    };

    const promises: Promise<void>[] = [];

    if (this.store && this.taskId) {
      promises.push(
        this.store.appendAgentLog(this.taskId, chunk, "thinking", undefined, this.agent).catch((err) => {
          this.log.warn(`Failed to flush thinking buffer for ${this.taskId}: ${err instanceof Error ? err.message : String(err)}`);
        }),
      );
    }

    if (this.appendLogCb) {
      promises.push(
        this.appendLogCb(entry).catch((err) => {
          this.log.warn(`appendLog callback failed for thinking flush: ${err instanceof Error ? err.message : String(err)}`);
        }),
      );
    }

    return Promise.all(promises).then(() => undefined);
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushTextBuffer();
    }, this.flushIntervalMs);
  }

  private scheduleThinkingFlush(): void {
    if (this.thinkingFlushTimer) return;
    this.thinkingFlushTimer = setTimeout(() => {
      this.thinkingFlushTimer = null;
      this.flushThinkingBuffer();
    }, this.flushIntervalMs);
  }
}
