import { createInterface } from "node:readline";
import { forceKillGrokStream, spawnGrokStream, type GrokStreamProcess, type SpawnGrokStreamOptions } from "./cli-stream.js";
import { parseLine } from "./stream-parser.js";
import type { AgentRuntime, AgentRuntimeOptions, AgentSession, AgentSessionResult, GrokSession } from "./types.js";

/*
FNXC:GrokCli 2026-07-10-10:54:
FN-7790: the production binary is xAI's Grok Build TUI, whose non-interactive prompt path is `grok -p <text> --output-format streaming-json` and whose NDJSON union is `thought`/`text`/`end` with payloads in `data`. Bridge `text.data` to `onText`, `thought.data` to `onThinking`, and record `end.sessionId` without resolving before subprocess close, because close still carries stderr/exit diagnostics. The obsolete `step_*`/`tool_use`/`error` handling targeted a different `grok` product and is intentionally removed so tests cannot pass on the wrong schema again.

FNXC:GrokCliRouting 2026-07-10-10:54:
FN-7753's auto-derived `grok` runtime routing from a `grok-cli/*` model selection still preserves the concrete model. Normalize provider-qualified ids (`grok-cli/<id>` or `grok/<id>`) at session creation/prompt time and pass only the concrete id to `grok -m`; the no-model Runtime-mode path keeps the historical `grok/default` session fallback and omits `-m`.
*/

/**
 * Cold-start ceiling: if `grok -p --output-format streaming-json` produces no
 * stdout line within this window, treat it as a hung/failed subprocess and
 * resolve (never reject — mirrors the Droid adapter's resolve-on-error lifecycle
 * so pi always gets a well-formed, if empty, result instead of an unhandled rejection).
 */
const FIRST_LINE_TIMEOUT_MS = 60_000;

/**
 * Inactivity safety net: kill the subprocess if no stdout line arrives for
 * this long after the first line. Generous ceiling mirroring the Droid
 * adapter's rationale — the caller (Fusion's stuck-task detection / abort
 * signal) is the authoritative "this session is stuck" source; this is a
 * last-resort guard for a catastrophically hung `grok` process.
 */
const INACTIVITY_TIMEOUT_MS = 30 * 60_000;

function normalizeGrokCliModel(model: string | undefined): string | undefined {
  const normalized = model?.trim();
  if (!normalized) return undefined;
  for (const prefix of ["grok-cli/", "grok/"]) {
    if (normalized.startsWith(prefix)) {
      const stripped = normalized.slice(prefix.length).trim();
      return stripped.length > 0 ? stripped : undefined;
    }
  }
  return normalized;
}

function modelForCli(model: string | undefined): string | undefined {
  const normalized = normalizeGrokCliModel(model);
  return normalized && normalized !== "default" ? normalized : undefined;
}

function compactDiagnostic(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function formatCloseDiagnostic(code: number | null, signal: NodeJS.Signals | null, stderr: string): string {
  const detail = compactDiagnostic(stderr);
  const exitDetail = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
  return detail ? `Grok CLI failed (${exitDetail}): ${detail}` : `Grok CLI failed with ${exitDetail} and no stderr output.`;
}

function formatNoNdjsonDiagnostic(firstStdoutLine: string | undefined): string {
  const firstLine = firstStdoutLine ? compactDiagnostic(firstStdoutLine) : "";
  if (firstLine) {
    return `Grok CLI produced stdout but no NDJSON events for a headless prompt; first line: ${firstLine}`;
  }
  return "Grok CLI produced no NDJSON output for a headless prompt; this usually means the binary on PATH is not xAI's supported Grok Build TUI headless implementation, did not recognize -p/--output-format streaming-json, or exited interactive mode immediately after stdin EOF.";
}

function appendMessage(session: GrokSession, role: "user" | "assistant", content: string): void {
  session.state.messages.push({ role, content });
}

export interface GrokRuntimeAdapterOptions {
  /** Binary name/path to invoke. Defaults to "grok" (PATH resolution). */
  binary?: string;
  /** Injectable spawn seam for tests — defaults to the real `spawnGrokStream`. */
  spawn?: (binary: string, prompt: string, options?: SpawnGrokStreamOptions) => GrokStreamProcess;
}

export class GrokRuntimeAdapter implements AgentRuntime {
  readonly id = "grok";
  readonly name = "Grok Runtime";
  private readonly binary: string;
  private readonly spawnFn: (binary: string, prompt: string, options?: SpawnGrokStreamOptions) => GrokStreamProcess;

  constructor(options?: GrokRuntimeAdapterOptions) {
    this.binary = options?.binary ?? "grok";
    this.spawnFn = options?.spawn ?? spawnGrokStream;
  }

  async createSession(
    options: {
      defaultModelId?: string;
      systemPrompt?: string;
      onText?: (text: string) => void;
      onThinking?: (text: string) => void;
      onToolStart?: (toolName: string, args?: unknown) => void;
      onToolEnd?: (toolName: string, isError: boolean, result?: unknown) => void;
    } = {},
  ): Promise<AgentSessionResult> {
    const model = normalizeGrokCliModel(options.defaultModelId) ?? "grok/default";
    const messages: unknown[] = [];
    const session: GrokSession = {
      model,
      systemPrompt: options.systemPrompt,
      messages,
      state: { messages },
      sessionId: undefined,
      lastModelDescription: `grok/${model}`,
      callbacks: {
        onText: options.onText,
        onThinking: options.onThinking,
        onToolStart: options.onToolStart,
        onToolEnd: options.onToolEnd,
      },
    };
    return { session, sessionFile: undefined };
  }

  async promptWithFallback(session: AgentSession, prompt: string, options?: AgentRuntimeOptions): Promise<void> {
    const grokSession = session as GrokSession;
    const cwd = options?.cwd;
    const signal = options?.signal;
    appendMessage(grokSession, "user", prompt);

    return new Promise<void>((resolve) => {
      let proc: GrokStreamProcess;
      try {
        proc = this.spawnFn(this.binary, prompt, { cwd, model: modelForCli(grokSession.model), signal });
      } catch (err) {
        // Spawn threw synchronously (e.g. binary not found without shell
        // resolution) — resolve, never reject, matching the CLI-adapter
        // contract of always producing a well-formed result while retaining
        // the concrete diagnostic for callers that surface session.state.
        const message = err instanceof Error ? err.message : String(err);
        const diagnostic = compactDiagnostic(`Grok CLI spawn failed: ${message}`);
        grokSession.state.errorMessage = diagnostic;
        grokSession.callbacks.onText?.(diagnostic);
        appendMessage(grokSession, "assistant", diagnostic);
        resolve();
        return;
      }

      let settled = false;
      let firstLineReceived = false;
      let receivedNdjsonEvent = false;
      let firstStdoutLine: string | undefined;
      let receivedText = false;
      let assistantText = "";
      let diagnosticEmitted = false;
      let stderr = "";
      let firstLineTimer: NodeJS.Timeout | undefined;
      let inactivityTimer: NodeJS.Timeout | undefined;

      const setErrorMessage = (message: string) => {
        if (message.trim().length === 0) return;
        grokSession.state.errorMessage = message;
      };

      const emitDiagnosticText = (message: string | undefined) => {
        const diagnostic = message?.trim();
        if (!diagnostic || receivedText || diagnosticEmitted) return;
        diagnosticEmitted = true;
        grokSession.callbacks.onText?.(diagnostic);
        appendMessage(grokSession, "assistant", diagnostic);
      };

      /*
      FNXC:GrokCli 2026-07-10-00:00:
      A failing headless `grok` run can close stdout before the child `close` event reports its non-zero exit and stderr. Resolving on readline close made dashboard Chat persist an empty assistant message before the diagnostic existed. Finalize only from subprocess close/error or lifecycle timeouts, and store concrete stderr/NDJSON error details on session.state.errorMessage so shared chat/executor seams can surface the reason without breaking the resolve-never-reject runtime contract.

      FNXC:GrokCli 2026-07-10-10:56:
      FN-7790 keeps FN-7788's zero-output diagnostic but updates the invariant for xAI Grok Build TUI: a valid `grok -p <text> --output-format streaming-json` run emits at least an `end` event, with optional `thought`/`text` events. A code-0 close with zero parsed NDJSON is a wrong-binary/interactive-EOF failure surfaced through both `onText` and `session.state.errorMessage`; a real `end` event with empty assistant text remains a legitimate silent response.
      */
      const finish = () => {
        if (settled) return;
        settled = true;
        if (firstLineTimer) clearTimeout(firstLineTimer);
        if (inactivityTimer) clearTimeout(inactivityTimer);
        if (assistantText) {
          appendMessage(grokSession, "assistant", assistantText);
        } else {
          emitDiagnosticText(grokSession.state.errorMessage);
        }
        resolve();
      };

      const resetInactivityTimer = () => {
        if (inactivityTimer) clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
          setErrorMessage(
            `Grok CLI stopped producing stdout for ${INACTIVITY_TIMEOUT_MS}ms during a headless prompt; the process was killed.`,
          );
          forceKillGrokStream(proc);
          finish();
        }, INACTIVITY_TIMEOUT_MS);
      };

      firstLineTimer = setTimeout(() => {
        if (firstLineReceived) return;
        setErrorMessage(
          `Grok CLI produced no stdout within ${FIRST_LINE_TIMEOUT_MS}ms for a headless prompt; the process was killed.`,
        );
        forceKillGrokStream(proc);
        finish();
      }, FIRST_LINE_TIMEOUT_MS);

      const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity, terminal: false });

      rl.on("line", (line: string) => {
        if (!firstLineReceived) {
          firstLineReceived = true;
          firstStdoutLine = line;
          if (firstLineTimer) clearTimeout(firstLineTimer);
        }
        resetInactivityTimer();

        const event = parseLine(line);
        if (!event) return;
        receivedNdjsonEvent = true;

        if (event.type === "text") {
          if (event.data.length > 0) {
            receivedText = true;
            assistantText += event.data;
          }
          grokSession.callbacks.onText?.(event.data);
        } else if (event.type === "thought") {
          grokSession.callbacks.onThinking?.(event.data);
        } else if (event.type === "end") {
          grokSession.sessionId = event.sessionId ?? grokSession.sessionId;
        }
        // `end` is the real xAI stream's terminal marker, but subprocess close
        // remains authoritative for resolving because close carries non-zero
        // exit/stderr diagnostics for failed runs.
      });

      proc.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });

      proc.on("error", (err) => {
        const message = err instanceof Error ? err.message : String(err);
        if (!receivedText) {
          setErrorMessage(compactDiagnostic(`Grok CLI process error: ${message}`));
        }
        finish();
      });

      proc.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
        try {
          rl.close();
        } catch {
          // already closed
        }
        const failed = typeof code === "number" ? code !== 0 : Boolean(signal);
        if (!receivedText && failed) {
          setErrorMessage(formatCloseDiagnostic(typeof code === "number" ? code : null, signal, stderr));
        } else if (!receivedText && !receivedNdjsonEvent && typeof code === "number" && code === 0) {
          setErrorMessage(formatNoNdjsonDiagnostic(firstStdoutLine));
        }
        finish();
      });

      rl.on("close", () => {
        // Wait for the child `close` event so non-zero exits can attach stderr
        // diagnostics before callers inspect the session.
      });
    });
  }

  describeModel(session: AgentSession): string {
    const grokSession = session as GrokSession;
    return grokSession.lastModelDescription || `grok/${grokSession.model ?? "default"}`;
  }
}
