import { createInterface } from "node:readline";
import { forceKillGrokStream, spawnGrokStream, type GrokStreamProcess, type SpawnGrokStreamOptions } from "./cli-stream.js";
import { parseLine } from "./stream-parser.js";
import type { AgentRuntime, AgentRuntimeOptions, AgentSession, AgentSessionResult, GrokErrorEvent, GrokSession } from "./types.js";

/*
FNXC:GrokCli 2026-07-09-00:00:
FN-7722: replaces the FN-7715 intentional no-op. Upstream grok-cli DOES
document and implement a non-interactive `grok --prompt <text> --format
json` NDJSON event stream (verified against primary source, not just docs
prose: src/index.ts's CLI parsing + src/headless/output.ts's
`createHeadlessJsonlEmitter` + its fixture tests). Contract captured in
docs/grok-cli-contract.md. This adapter spawns that command via the
`cli-stream` seam, parses NDJSON via `stream-parser.parseLine`, and drives
`onText` as `text` events arrive.

FNXC:GrokCli 2026-07-09-00:10:
FN-7724: extends the above with `tool_use` (and terminal `step_finish`/
`error`) bridging, per docs/grok-cli-contract.md's verified NDJSON schema.
`onToolStart`/`onToolEnd` fire from each `tool_use` event's
`toolCall`/`toolResult`, mirroring the Droid plugin's `DroidCallbacks`
shape. No Grok→pi tool-name/arg mapping is applied: the verified contract
does not pin grok-cli's specific tool-name vocabulary (unlike Droid's
Claude-shaped names), so `toolCall.function.name`/parsed `.arguments` pass
through unchanged (decision recorded in the FN-7724 `research` task
document). `onThinking` is still never invoked — the verified schema has no
thinking/reasoning event (confirmed absence, not a gap). The terminal
lifecycle is UNCHANGED from FN-7722: the doc states `step_finish` is a
per-step boundary (multiple can occur per run for multi-round tool use), so
it does NOT finalize the promise here; only subprocess `close`/`error`
does, same `streamEnded`-guarded (via the existing `settled` flag)
resolve-never-reject lifecycle as before. This adapter is only reached when
an agent's `runtimeConfig.runtimeHint === "grok"` (wired end-to-end by
FN-7725).

FNXC:GrokCliRouting 2026-07-09-00:00:
FN-7753: auto-derived `grok` runtime routing from a `grok-cli/*` model selection must preserve the concrete model. Normalize provider-qualified ids (`grok-cli/<id>` or `grok/<id>`) at session creation/prompt time and pass only the concrete id to `grok --model`; the no-model Runtime-mode path keeps the historical `grok/default` session fallback and omits `--model`.
*/

/**
 * Cold-start ceiling: if `grok --prompt --format json` produces no stdout
 * line within this window, treat it as a hung/failed subprocess and resolve
 * (never reject — mirrors the Droid adapter's resolve-on-error lifecycle so
 * pi always gets a well-formed, if empty, result instead of an unhandled
 * rejection).
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

/**
 * FNXC:GrokCli 2026-07-09-00:10:
 * FN-7724: `toolCall.function.arguments` is a JSON-encoded string per the
 * verified `ToolCall` shape (docs/grok-cli-contract.md / types.ts's
 * `GrokToolCallLike`). Parse it defensively — malformed/missing arguments
 * must never throw inside the NDJSON read loop; fall back to the raw string
 * (or undefined) so callers still see something rather than losing the
 * event, mirroring the Droid event-bridge's empty-args guard.
 */
function parseToolArguments(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  if (raw === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

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

function formatErrorEventDiagnostic(event: GrokErrorEvent): string {
  const detail = compactDiagnostic(event.message);
  return detail ? `Grok CLI error: ${detail}` : "Grok CLI emitted an error event without a message.";
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
        grokSession.state.errorMessage = compactDiagnostic(`Grok CLI spawn failed: ${message}`);
        resolve();
        return;
      }

      let settled = false;
      let firstLineReceived = false;
      let receivedText = false;
      let stderr = "";
      let firstLineTimer: NodeJS.Timeout | undefined;
      let inactivityTimer: NodeJS.Timeout | undefined;

      const setErrorMessage = (message: string) => {
        if (message.trim().length === 0) return;
        grokSession.state.errorMessage = message;
      };

      /*
      FNXC:GrokCli 2026-07-10-00:00:
      A failing headless `grok` run can close stdout before the child `close` event reports its non-zero exit and stderr. Resolving on readline close made dashboard Chat persist an empty assistant message before the diagnostic existed. Finalize only from subprocess close/error or lifecycle timeouts, and store concrete stderr/NDJSON error details on session.state.errorMessage so shared chat/executor seams can surface the reason without breaking the resolve-never-reject runtime contract.
      */
      const finish = () => {
        if (settled) return;
        settled = true;
        if (firstLineTimer) clearTimeout(firstLineTimer);
        if (inactivityTimer) clearTimeout(inactivityTimer);
        resolve();
      };

      const resetInactivityTimer = () => {
        if (inactivityTimer) clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
          forceKillGrokStream(proc);
          finish();
        }, INACTIVITY_TIMEOUT_MS);
      };

      firstLineTimer = setTimeout(() => {
        if (firstLineReceived) return;
        forceKillGrokStream(proc);
        finish();
      }, FIRST_LINE_TIMEOUT_MS);

      const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity, terminal: false });

      rl.on("line", (line: string) => {
        if (!firstLineReceived) {
          firstLineReceived = true;
          if (firstLineTimer) clearTimeout(firstLineTimer);
        }
        resetInactivityTimer();

        const event = parseLine(line);
        if (!event) return;

        if (event.type === "text") {
          receivedText = receivedText || event.text.length > 0;
          grokSession.callbacks.onText?.(event.text);
        } else if (event.type === "tool_use") {
          // FNXC:GrokCli 2026-07-09-00:10: FN-7724 — bridge the verified
          // tool_use event. toolCall.function.name/arguments and
          // toolResult.success/output are the verified fields
          // (docs/grok-cli-contract.md); pass-through, no name/arg mapping
          // (see FN-7724 research task document for the decision).
          const toolName = event.toolCall?.function?.name ?? event.toolCall?.type ?? "unknown";
          const args = parseToolArguments(event.toolCall?.function?.arguments);
          grokSession.callbacks.onToolStart?.(toolName, args);
          const isError = event.toolResult?.success === false;
          grokSession.callbacks.onToolEnd?.(toolName, isError, event.toolResult);
        } else if (event.type === "error") {
          setErrorMessage(formatErrorEventDiagnostic(event));
        }
        // step_start / step_finish: step_finish is a per-step boundary (not
        // run-terminal, per docs/grok-cli-contract.md — a run can have
        // multiple step_start/step_finish pairs for multi-round tool use), so
        // it is intentionally NOT bridged into a callback or treated as the
        // finalize signal; only subprocess close/error finalizes (see finish()
        // below).
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
