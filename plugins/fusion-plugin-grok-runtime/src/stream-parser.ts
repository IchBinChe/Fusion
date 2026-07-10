import type { GrokNdjsonEvent } from "./types.js";

/*
FNXC:GrokCli 2026-07-10-10:50:
FN-7790: xAI's official Grok Build TUI streams newline-delimited `thought`/`text`/`end` JSON from `grok -p <prompt> --output-format streaming-json`. The previously accepted `step_*`/`tool_use`/`error` events described a different `grok` binary and masked production no-message failures, so unknown legacy lines now fall through as unrecognized while the parser keeps its never-throw resilience.
*/
const KNOWN_EVENT_TYPES = new Set(["thought", "text", "end"]);

/**
 * Parse a single NDJSON line from `grok -p --output-format streaming-json` stdout into a
 * typed event, or null when the line should be skipped (empty, non-JSON
 * debug noise, malformed JSON, or a JSON object whose `type` isn't one of
 * the real xAI streaming event types).
 */
export function parseLine(line: string): GrokNdjsonEvent | null {
  const trimmed = line.trim();

  // Skip empty lines
  if (!trimmed) {
    return null;
  }

  // Skip non-JSON lines (e.g. any stray debug/log output not part of the JSONL stream)
  if (!trimmed.startsWith("{")) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    console.error("Failed to parse Grok CLI NDJSON line:", trimmed);
    return null;
  }

  // Validate that the parsed result is a non-null object (not array, not primitive)
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const candidate = parsed as { type?: unknown };
  if (typeof candidate.type !== "string" || !KNOWN_EVENT_TYPES.has(candidate.type)) {
    return null;
  }

  return parsed as GrokNdjsonEvent;
}
