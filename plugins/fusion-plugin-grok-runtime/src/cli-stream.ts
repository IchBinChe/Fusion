import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

/*
FNXC:GrokCli 2026-07-10-10:49:
FN-7790: the operator-installed binary is xAI's Grok Build TUI (`grok 0.2.93`), not the previously assumed `superagent-ai/grok-cli`. Invoke the real headless contract, `grok -p <prompt> --output-format streaming-json [-m <model>] [--cwd <dir>]`; the old `--prompt`/`--format json`/`--directory` flags are rejected by the real binary and produce zero assistant text. Keep the existing foreground pipe and Windows shell handling so the adapter can stream line-by-line NDJSON without raw detached processes.
*/

export type GrokStreamProcess = ChildProcessByStdio<null, Readable, Readable>;

export interface SpawnGrokStreamOptions {
  cwd?: string;
  model?: string;
  signal?: AbortSignal;
}

/**
 * Spawn `grok -p <prompt> --output-format streaming-json [-m <model>] [--cwd <cwd>]`
 * with piped stdio for line-by-line NDJSON consumption via readline.
 *
 * Does not read/buffer output itself — callers attach a `readline` interface
 * to `proc.stdout` (see `runtime-adapter.ts`).
 */
export function spawnGrokStream(binary: string, prompt: string, options?: SpawnGrokStreamOptions): GrokStreamProcess {
  const args: string[] = ["-p", prompt, "--output-format", "streaming-json"];
  const model = options?.model?.trim();
  if (model) {
    // FNXC:GrokCliRouting 2026-07-10-10:49: FN-7790 keeps FN-7753's concrete `grok-cli/*` model preservation but uses xAI Grok Build TUI's accepted short flag, `-m <model>`, with the provider prefix stripped by runtime-adapter.ts.
    args.push("-m", model);
  }
  if (options?.cwd) {
    args.push("--cwd", options.cwd);
  }

  return spawn(binary, args, {
    cwd: options?.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
    signal: options?.signal,
  }) as GrokStreamProcess;
}

/** Force-kill a Grok CLI streaming subprocess. Best-effort; never throws. */
export function forceKillGrokStream(proc: GrokStreamProcess): void {
  try {
    proc.kill("SIGKILL");
  } catch {
    // best effort
  }
}
