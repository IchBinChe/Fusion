# Grok CLI Contract (FN-7790)

Date: 2026-07-10

<!--
FNXC:GrokCli 2026-07-10-11:17:
FN-7790 supersedes the FN-7722/FN-7724 contract that targeted `superagent-ai/grok-cli`. Operators actually run xAI's official Grok Build TUI (`grok 0.2.93`), so Fusion must invoke `grok -p <prompt> --output-format streaming-json` and parse `thought`/`text`/`end` events; the old `--prompt`/`--format json` plus `step_*` schema is a wrong-product assumption that produced no assistant response.
-->

## Ground truth

Fusion shells out to an **operator-installed** `grok` binary. The binary is not downloaded or bundled by Fusion, so the authoritative contract is the installed xAI CLI's own help/version output plus live execution on an authenticated machine.

External integration evidence:

- Canonical upstream: xAI official Grok CLI / Grok Build TUI, surfaced by the installed binary as `grok 0.2.93 (f00f96316d4b)`.
- Docs/homepage: https://grok.com/, https://docs.x.ai/, and `grok --help` / `grok agent --help` for exact flags.
- Release/download: operator-installed; Fusion resolves `grok` from PATH or `grokCliBinaryPath` and does not bundle a release artifact.
- Binary name: `grok`.
- Checksum: `upstream-pending-verification` because Fusion does not pin or download the operator's binary.

The previously documented https://github.com/superagent-ai/grok-cli contract is a different product that happens to use the same binary name. Its `grok --prompt <text> --format json` invocation is not accepted by xAI's CLI.

## Failure that caused FN-7790

The old adapter invocation fails against the real xAI binary:

```bash
grok --prompt "say hello" --format json
```

Observed result:

```text
exit 2
stdout: <empty>
stderr:
error: unexpected argument '--prompt' found

  tip: a similar argument exists: '--prompt-file'

Usage: grok --prompt-file <PATH> [PROMPT]
```

Because no NDJSON `text` event is produced, Fusion surfaced a blank/no-message assistant response.

## Confirmed non-interactive invocation

Use xAI Grok Build TUI's single-turn prompt mode with streaming JSON:

```bash
grok -p "<text>" --output-format streaming-json
# equivalent long prompt flag:
grok --single "<text>" --output-format streaming-json
```

Supported companion flags used by Fusion:

- `-p, --single <PROMPT>` — run a single prompt, print the response, and exit. This does not require interactive stdin.
- `--output-format <plain|json|streaming-json>` — streaming adapter uses `streaming-json`.
- `-m, --model <MODEL>` — optional concrete model id. Fusion omits this for the model-less `grok/default` Runtime-mode path.
- `--cwd <CWD>` — optional working directory. This replaces the wrong-product `--directory` flag.

Other observed flags include `--prompt-file <PATH>`, `--prompt-json <JSON>`, `-s/--session-id <UUID>`, `--sandbox <PROFILE>`, `--system-prompt-override <PROMPT>`, and `--max-turns <N>`, but Fusion's adapter does not currently use them.

## Streaming JSON event schema

`--output-format streaming-json` emits one JSON object per line:

```ts
type GrokStreamingJsonEvent =
  | { type: "thought"; data: string }
  | { type: "text"; data: string }
  | { type: "end"; stopReason?: string; sessionId?: string; requestId?: string };
```

Mapping in Fusion:

- `thought.data` → `onThinking(thought.data)`.
- `text.data` → `onText(text.data)` and accumulated assistant content.
- `end.sessionId` → `session.sessionId` when present. `end` pre-signals terminal output, but subprocess `close` remains the authoritative promise resolution point because it carries exit status/stderr diagnostics.

Real captured tail:

```jsonl
{"type":"thought","data":" one"}
{"type":"thought","data":"-"}
{"type":"thought","data":"word"}
{"type":"thought","data":" greeting"}
{"type":"thought","data":"."}
{"type":"text","data":"Hello"}
{"type":"text","data":"!"}
{"type":"end","stopReason":"EndTurn","sessionId":"019f4d1e-2582-70e0-a174-c8774782ab01","requestId":"2233f1dc-e9ad-4ae4-8221-caa6afade07f"}
```

A successful run exits 0 with empty stderr.

## Non-streaming formats

`--output-format plain` prints renderable response text.

`--output-format json` emits one final JSON object rather than an NDJSON stream. Observed shape:

```json
{
  "text": "hi",
  "stopReason": "EndTurn",
  "sessionId": "019f4d18-875b-7662-9bc5-9b71fa0aa6b0",
  "requestId": "0e8ef53f-5a5f-4564-a8fd-0200ef96440e",
  "thought": "The user wants me to say hi in one word..."
}
```

Fusion uses `streaming-json` for live `onText`/`onThinking` callbacks.

## Model discovery

`grok models` is plain text, not JSON. Observed shape:

```text
You are logged in with grok.com.

Default model: grok-4.5

Available models:
  * grok-4.5 (default)
  - grok-composer-2.5-fast
```

Fusion parses the bullet list conservatively and exposes ids under provider `grok-cli` when the `useGrokCli` toggle is enabled.

## Auth and readiness

The CLI owns authentication for CLI-routed execution. Fusion's readiness probe uses `grok --version`; a passing probe proves only that a compatible-looking binary exists, not that the prompt path is authenticated or serviceable. The prompt path is proven by a real `grok -p ... --output-format streaming-json` run.

Fusion-visible `GROK_API_KEY` remains relevant for the direct xAI OpenAI-compatible endpoint. For CLI-routed sessions, Fusion does not need to see a key as long as the operator-installed CLI is authenticated by its own supported mechanism.

## Runtime routing

The Grok runtime adapter is reached when:

1. an agent explicitly sets `runtimeConfig.runtimeHint === "grok"`; or
2. the FN-7753/FN-7758 no-visible-key fallback derives the same runtime hint for a `grok-cli/*` default/fallback provider selection and the bundled Grok Runtime plugin is registered.

The selected `grok-cli/<id>` or `grok/<id>` model is normalized to `<id>` and passed to the CLI as `-m <id>`. The explicit no-model Runtime-mode path keeps `grok/default` and omits `-m`.

## Diagnostics and empty-output invariant

The adapter preserves the resolve-never-reject runtime contract while surfacing concrete diagnostics:

- spawn failure → `session.state.errorMessage` and diagnostic `onText`.
- non-zero subprocess close with no text → stderr/exit diagnostic.
- code-0 close with zero parsed NDJSON → wrong-binary/interactive-EOF diagnostic.
- parsed `end` with no accumulated assistant text → legitimate silent response, not a diagnostic.
- text emitted before a noisy/non-zero close → keep the assistant text and avoid replacing it with an error.

This invariant prevents the original blank/no-message symptom while still allowing genuinely empty model turns.
