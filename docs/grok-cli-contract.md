# Grok CLI Contract (FN-7722)

Date: 2026-07-09

<!--
FNXC:GrokCli 2026-07-09-00:00:
FN-7715 shipped GrokRuntimeAdapter.promptWithFallback as an intentional no-op,
justified by an FNXC comment asserting "no documented non-interactive
prompt/stream subcommand" for the `grok` CLI. FN-7722 (this doc) corrects that
assumption: upstream grok-cli DOES document and implement a non-interactive
`grok --prompt <text> --format json` NDJSON event stream
(src/headless/output.ts's `createHeadlessJsonlEmitter`), and this task lands a
real streaming GrokRuntimeAdapter against that verified contract. See
"Decision" below.
-->

## Research method

- `fn_web_fetch` against the canonical upstream repository
  (https://github.com/superagent-ai/grok-cli), specifically:
  - `README.md` (headless-mode overview, feature summary).
  - `src/index.ts` (commander CLI argument parsing — the exact flag
    spellings and headless dispatch).
  - `src/headless/output.ts` (the actual NDJSON event emitter — the
    authoritative schema source, not just docs prose).
  - `src/headless/output.test.ts` (fixture-level confirmation of the emitted
    JSONL shapes, used as ground truth for this plugin's own fixture tests).
- No live `grok` binary was invoked; no field name or flag spelling in this
  document is guessed — every claim below traces to one of the four files
  above. Raw captured research (queries + verbatim schema) is preserved as
  this task's `research` task document (`fn_task_document_read` key
  `research` on FN-7722).

## Confirmed non-interactive invocation

```bash
grok --prompt "<text>" --format json
# short flags:
grok -p "<text>" --format json
```

- `-p, --prompt <prompt>` — run a single prompt headlessly, then exit.
- `--format <format>` — headless output format, `text` (default) or `json`;
  invalid values are rejected by commander's `InvalidArgumentError`
  (`parseHeadlessOutputFormat`/`isHeadlessOutputFormat` in `src/index.ts`).
- Useful companion flags confirmed in the same `program.option(...)` chain:
  `-d, --directory <dir>` (cwd), `-m, --model <model>`, `-s, --session <id>`
  (resume a saved session, or `latest`), `-k, --api-key <key>` (inline key).
- `--format json` output is **newline-delimited JSON (NDJSON/JSONL)** — one
  JSON object per line — not a single JSON document. This is directly
  confirmed by `createHeadlessJsonlEmitter()`'s `jsonLine()` helper in
  `src/headless/output.ts`, which appends `\n` after each `JSON.stringify`.

## Verified NDJSON event schema (verbatim)

Source: `HeadlessJsonEvent` union type in `src/headless/output.ts`.

```ts
type HeadlessJsonEvent =
  | { type: "step_start"; sessionID?: string; stepNumber: number; timestamp: number }
  | { type: "text"; sessionID?: string; stepNumber: number; text: string; timestamp: number }
  | {
      type: "tool_use";
      sessionID?: string;
      stepNumber: number;
      timestamp: number;
      toolCall: ToolCall;
      toolResult: ToolResult;
      timing?: { startedAt?: number; finishedAt?: number; durationMs?: number };
    }
  | {
      type: "step_finish";
      sessionID?: string;
      stepNumber: number;
      timestamp: number;
      finishReason: string;
      usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number; costUsdTicks?: number };
    }
  | { type: "error"; sessionID?: string; message: string; timestamp: number };
```

Notes:

- `sessionID` appears on every event type when a session id is available
  (`agent.getSessionId()`); it is simply absent from the JSON object
  otherwise (not `null`).
- `text` events are per-step, buffered assistant content — one `text` event
  per step carrying the accumulated text for that step, flushed either right
  before a tool-triggering `step_finish` or inline with a tool-less
  `step_finish`.
- **No `thinking`/`reasoning` NDJSON event exists.** The underlying
  `StreamChunk` union used internally does carry a `"reasoning"` chunk type,
  but `createHeadlessJsonlEmitter().consumeChunk()` explicitly no-ops on it
  (`case "reasoning": break;` in `src/headless/output.ts`) — reasoning
  content is never surfaced through `--format json`. This is a **confirmed
  absence**, not `upstream-pending-verification`: the Grok streaming adapter
  therefore drives `onText` only; there is no `onThinking` signal to bridge
  for this CLI path today.
- There is **no explicit terminal `done`/`result` event type**. A prompt run
  can contain multiple `step_start`/`step_finish` pairs (multi-round tool
  use); the authoritative "the run is over" signal is the headless process's
  stdout stream ending (readline `close`) / subprocess exit, mirroring how
  the Droid CLI adapter treats subprocess `close` as terminal. `error` events
  (`{ type: "error", message, timestamp }`) can also appear inline without
  necessarily ending the process.
- A **fatal, pre-JSON failure** (e.g. missing API key) is not a JSON line at
  all: `src/index.ts`'s `requireApiKey()` writes a plain `console.error(...)`
  line to stderr and calls `process.exit(1)` before any NDJSON is emitted.
  Consumers must therefore also treat a non-zero exit with no JSON output as
  a distinct failure mode from a well-formed `error` event.

## Auth / readiness

- **The `grok` CLI owns authentication end-to-end for CLI-routed execution.**
  `runHeadless()` in `src/index.ts` is only reached via
  `requireApiKey(config.apiKey)`, which resolves the key from (in order via
  `resolveConfig`/`getApiKey()`): `-k/--api-key` flag, `GROK_API_KEY` env var,
  project `.env`, or `~/.grok/user-settings.json`'s `apiKey` field. If none
  resolve, the CLI itself exits 1 with an actionable error — Fusion does not
  need to pass, see, or validate a key for this path to work, as long as the
  operator's `grok` install already has one configured by any of those
  methods.
- **Auth implication for this task:** because CLI-routed model selections let
  the `grok` binary own both auth and inference, the direct-endpoint
  `GROK_API_KEY` Fusion-visibility requirement established by FN-7711
  (built-in `xai`/`openai-completions` provider) and FN-7714 (hydrating
  `GROK_API_KEY` from `~/.grok/user-settings.json` when the env var is unset)
  becomes **unnecessary for CLI-routed selections specifically**. It remains
  necessary and unchanged for the direct xAI OpenAI-compatible path, which
  stays the default (see "What stays unchanged" below).
- This mirrors FN-7716's separate finding that Grok CLI *readiness* (probe/
  auth-status surfacing) does not require Fusion to see a key either — that
  surface (`probe.ts`, `register-auth-routes.ts`,
  `GrokCliProviderCard.tsx`) is out of scope for this task and is not
  modified here.

## Wiring gap (recorded, not closed by this task)

`packages/engine/src/runtime-resolution.ts`'s `resolveRuntime()` only reaches
a plugin runtime adapter (like `GrokRuntimeAdapter`) when
`runtimeConfig.runtimeHint === "grok"`. A repo-wide grep at Step 0 of this
task confirmed **nothing in the product sets `runtimeHint` to `"grok"`
today** (task/agent config, settings, or otherwise) — the same wiring gap
FN-7715's stale comment already noted. This task lands the adapter
implementation and its tests, but does **not** wire an end-to-end path that
exercises it (no product code sets `runtimeHint: "grok"`, and no settings
toggle exists to prefer CLI execution over the direct endpoint). That wiring
is filed as a follow-up task (see `fn_task_create` entries linked from this
task).

## Decision

**Route Grok execution through the CLI: YES, as a scoped, additive
`GrokRuntimeAdapter` implementation.**

Rationale:

- The non-interactive contract is fully pinned to primary source code
  (`src/index.ts` CLI parsing + `src/headless/output.ts` emitter +
  `src/headless/output.test.ts` fixtures), not just README prose — this
  clears the External Integration Evidence bar and the "testable from
  fixture lines without a live binary" bar from the task mission — the
  parser can be fixture-tested exactly like the Droid plugin's
  `stream-parser.ts`, with no live-binary dependency in tests.
- The event schema is simple (`step_start` / `text` / `tool_use` /
  `step_finish` / `error`) and text-only for this scoped adapter (no
  `thinking` event exists to bridge), so the implementation stays narrow: a
  resilient NDJSON line parser plus an `onText` bridge, deliberately leaving
  tool-call/break-early bridging as a documented follow-up (the Droid
  adapter's much larger `provider.ts` is the effort ceiling, not the target
  shape).
- It is fully reversible: the adapter is only reachable via
  `runtimeHint === "grok"`, which nothing sets today, so landing it carries
  no behavioral change to any exercised path.

## What stays unchanged

- The **direct xAI OpenAI-compatible streaming path** (base URL
  `https://api.x.ai/v1`, api type `openai-completions`, `GROK_API_KEY`
  sourced per FN-7711/FN-7714) remains the default, exercised Grok execution
  path. This task does not touch `packages/core/src/grok-provider.ts` or
  `packages/engine/src/pi.ts`.
- FN-7716's probe/auth-readiness surface (`probe.ts`,
  `register-auth-routes.ts`, `GrokCliProviderCard.tsx`) is untouched by this
  task.
- End-to-end routing (making the product actually set
  `runtimeHint === "grok"`, or adding a settings toggle to prefer the CLI
  over the direct endpoint) is explicitly out of scope here and is filed as
  a follow-up task.

## Follow-ups filed from this task

See the task's `fn_task_create` calls (linked from FN-7722) for:

1. End-to-end routing wiring — actually setting `runtimeHint === "grok"` (or
   a settings toggle preferring the CLI) so `GrokRuntimeAdapter` is
   exercised in a real execution path.
2. Full tool-call/break-early bridging for `tool_use` NDJSON events, if a
   future need for Grok-CLI-driven tool execution arises (out of scope for
   the scoped text/no-thinking adapter landed here).
