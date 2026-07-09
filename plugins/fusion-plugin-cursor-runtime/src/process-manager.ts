import { runCursorCommand } from "./cli-spawn.js";

const EMPTY_ACCOUNT_MESSAGE = "no models available for this account.";

/*
FNXC:CursorCli 2026-07-08-00:00:
`cursor-agent models` is plain text, NOT JSON — the real CLI rejects `--json`
(`error: unknown option '--json'`) and has no `model list` subcommand. Output
shape is: an `Available models` header line, a blank line, then one model per
line as `<id> - <Label>` (e.g. `auto - Auto (default)`), ending with a
`Tip: use --model <id> ...` line. An empty account prints the single line
`No models available for this account.`. We strip the header/tip/empty-state
lines and take the text before the first ` - ` as the bare model id.
*/
function parseModelLines(raw: string): string[] {
  const ids = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.toLowerCase() !== "available models")
    .filter((line) => line.toLowerCase() !== EMPTY_ACCOUNT_MESSAGE)
    .filter((line) => !/^tip:/i.test(line))
    .filter((line) => !line.toLowerCase().startsWith("usage"))
    .map((line) => {
      const separatorIndex = line.indexOf(" - ");
      return separatorIndex === -1 ? line : line.slice(0, separatorIndex).trim();
    })
    .filter(Boolean);

  return Array.from(new Set(ids));
}

export async function discoverCursorModels(binary: string, timeoutMs = 5000): Promise<{ models: string[]; source: string; fallbackUsed: boolean; reason?: string }> {
  const res = await runCursorCommand(binary, ["models"], timeoutMs);
  if (res.code !== 0) {
    return { models: [], source: "none", fallbackUsed: true, reason: "model discovery command unavailable" };
  }

  const output = (res.stdout || "").trim();
  if (!output) {
    return { models: [], source: "none", fallbackUsed: true, reason: "model discovery command returned no output" };
  }

  if (output.toLowerCase() === EMPTY_ACCOUNT_MESSAGE) {
    return { models: [], source: "models-text", fallbackUsed: false, reason: "no models available for this account" };
  }

  // Defensive fallback: tolerate output that happens to be JSON, even though
  // the real CLI does not support --json today.
  try {
    const parsed = JSON.parse(output);
    if (Array.isArray(parsed)) {
      const ids = parsed
        .map((entry) => (typeof entry === "string" ? entry : typeof entry?.id === "string" ? entry.id : undefined))
        .filter((id): id is string => Boolean(id));
      if (ids.length > 0) {
        return { models: Array.from(new Set(ids)), source: "models-json", fallbackUsed: false };
      }
    }
  } catch {
    // output is not JSON; fall through to line-based parsing
  }

  const ids = parseModelLines(output);
  if (ids.length > 0) {
    return { models: ids, source: "models-text", fallbackUsed: false };
  }

  return { models: [], source: "none", fallbackUsed: true, reason: "model discovery command unavailable" };
}
