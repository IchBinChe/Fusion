import { createInterface } from "node:readline";
import { forceKillGrokStream, spawnGrokStream, type GrokStreamProcess, type SpawnGrokStreamOptions } from "./cli-stream.js";
import { parseLine } from "./stream-parser.js";
import type { AgentRuntime, AgentRuntimeOptions, AgentSession, AgentSessionResult, GrokSession } from "./types.js";

/*
FNXC:GrokCli 2026-07-09-00:00:
FN-7722: replaces the FN-7715 intentional no-op. Upstream grok-cli DOES
document and implement a non-interactive `grok --prompt <text> --format
json` NDJSON event stream (verified against primary source, not just docs
prose: src/index.ts's CLI parsing + src/headless/output.ts's
`createHeadlessJsonlEmitter` + its fixture tests). Contract captured in
docs/grok-cli-contract.md. This adapter spawns that command via the
`cli-stream` seam, parses NDJSON via `stream-parser.parseLine`, and drives
`onText` as `text` events arrive. Scoped deliberately narrow, mirroring the
Droid plugin's parser+text-bridge pattern but NOT its full tool-call/
break-early machinery: the verified schema has no thinking/reasoning event
(onThinking is therefore never invoked here — kept only for AgentRuntime
interface parity), and tool_use bridging is filed as a follow-up (see
docs/grok-cli-contract.md "Follow-ups"). This adapter is only reached when
an agent's `runtimeConfig.runtimeHint === "grok"`, which nothing in the
product sets today (recorded as the wiring gap in the contract doc) — this
task lands the adapter without wiring an end-to-end exercised path.
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

  async createSession(options: { defaultModelId?: string; systemPrompt?: string; onText?: (text: string) => void; onThinking?: (text: string) => void } = {}): Promise<AgentSessionResult> {
    const model = options.defaultModelId ?? "grok/default";
    const session: GrokSession = {
      model,
      systemPrompt: options.systemPrompt,
      messages: [],
      sessionId: undefined,
      lastModelDescription: `grok/${model}`,
      callbacks: {
        onText: options.onText,
        onThinking: options.onThinking,
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
        proc = this.spawnFn(this.binary, prompt, { cwd, signal });
      } catch {
        // Spawn threw synchronously (e.g. binary not found without shell
        // resolution) — resolve, never reject, matching the CLI-adapter
        // contract of always producing a well-formed (if empty) result.
        resolve();
        return;
      }

      let settled = false;
      let firstLineReceived = false;
      let firstLineTimer: NodeJS.Timeout | undefined;
      let inactivityTimer: NodeJS.Timeout | undefined;

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
          grokSession.callbacks.onText?.(event.text);
        }
        // step_start / tool_use / step_finish / error: intentionally not
        // bridged by this scoped adapter (text-only). tool_use bridging is
        // a follow-up (docs/grok-cli-contract.md).
      });

      proc.on("error", () => {
        finish();
      });

      proc.on("close", () => {
        try {
          rl.close();
        } catch {
          // already closed
        }
        finish();
      });

      rl.on("close", () => {
        finish();
      });
    });
  }

  describeModel(session: AgentSession): string {
    const grokSession = session as GrokSession;
    return grokSession.lastModelDescription || `grok/${grokSession.model ?? "default"}`;
  }
}
