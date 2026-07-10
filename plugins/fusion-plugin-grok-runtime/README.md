# fusion-plugin-grok-runtime

Grok CLI-backed provider/runtime plugin for Fusion.

## Install

This plugin ships bundled with Fusion and is auto-installed like the other
built-in runtime plugins. It shells out to an **operator-installed** `grok`
binary on PATH — Fusion never downloads or bundles the CLI itself.

- Canonical upstream: xAI official Grok CLI / Grok Build TUI (`grok --version` observed as `grok 0.2.93 (f00f96316d4b)`).
- Docs / homepage: https://grok.com/, https://docs.x.ai/, and `grok --help` / `grok agent --help` for exact flags.
- Release / download: operator-installed; Fusion resolves `grok` from PATH or `grokCliBinaryPath`.
- Binary name: `grok`.
- Checksum: `upstream-pending-verification` because Fusion does not download or pin the operator's binary.

The previously assumed `superagent-ai/grok-cli` contract is a different product that shares the `grok` binary name. This plugin targets xAI's official CLI contract.

## Contract summary

- Provider ID: `grok-cli`
- Binary probe: `grok --version`
- **Auth model — the `grok` CLI owns its own authentication; Fusion does not require a Fusion-visible API key to enable/use it (FN-7716).** Fusion additionally probes the `GROK_API_KEY` env var and `~/.grok/user-settings.json` → `{ "apiKey": "..." }` purely as a **non-blocking informational hint** (`apiKeyDetected`); it never gates Enable or the authenticated state. The direct xAI OpenAI-compatible streaming path (base URL `https://api.x.ai/v1`) still uses `$GROK_API_KEY` when present, independent of the CLI provider.
- Model discovery: `grok models` (plain text). The observed xAI shape is `Default model: <id>`, then `Available models:`, then `* <id> (default)` / `- <id>` bullet rows.

## CLI streaming execution path (FN-7790)

The plugin's `GrokRuntimeAdapter` streams a real Grok response through xAI's CLI:

```bash
grok -p "<text>" --output-format streaming-json
# with optional model/cwd:
grok -p "<text>" --output-format streaming-json -m "grok-4.5" --cwd "/path/to/project"
```

- `-p, --single <PROMPT>` runs a single prompt and exits; it does not require interactive stdin.
- `--output-format streaming-json` emits NDJSON with event types `thought`, `text`, and `end`.
- `thought.data` drives `onThinking`; `text.data` drives `onText` and persisted assistant content; `end.sessionId` is stored when present. The subprocess `close` event remains the authoritative resolution point so stderr/exit diagnostics are preserved.
- A wrong-binary/wrong-flag run that emits no parsed NDJSON surfaces a concrete diagnostic instead of a blank assistant response. A real `end` event with empty accumulated text remains a legitimate silent response.
- **Auth implication:** because the `grok` binary resolves its own credentials for this path, a CLI-routed selection needs **no Fusion-visible `GROK_API_KEY`** — unlike the direct xAI OpenAI-compatible streaming path.

See `docs/grok-cli-contract.md` for the full contract, live captures, and the reason Fusion no longer uses the old `grok --prompt <text> --format json` / `step_*` schema.

## Routing Grok through the CLI runtime (FN-7725 / FN-7753 / FN-7790)

By default, selecting a `grok-cli/*` **model** for an agent/task routes through
the **direct xAI OpenAI-compatible endpoint** (`https://api.x.ai/v1`,
FN-7711/FN-7714) whenever Fusion can see a `GROK_API_KEY` (environment or
`~/.grok/user-settings.json` `apiKey`). If no Fusion-visible key resolves and
the Grok Runtime plugin is registered, Fusion automatically routes that session
through the `grok` CLI runtime instead, letting the CLI own auth end-to-end.

To route a specific agent's execution through the `grok` CLI runtime explicitly:

1. Open the agent in the dashboard (**New Agent** or an existing agent's detail view).
2. Under **Runtime Source**, choose **Runtime** instead of **Built-in Model**.
3. Select **Grok Runtime** from the runtime dropdown (sourced from `GET /api/plugins/runtimes`).
4. Save. The agent's `runtimeConfig.runtimeHint` is now `"grok"`; every session that agent drives resolves through this plugin's `GrokRuntimeAdapter` instead of the default pi runtime.

**Automatic fallback precedence (FN-7753):** explicit runtime hint > Fusion-visible key/direct endpoint > automatic CLI fallback. The fallback is only derived when no explicit runtime hint is set, the provider is `grok-cli`, no Fusion-visible key resolves, and runtime id `"grok"` is registered. The selected model is normalized from `grok-cli/<id>` (or `grok/<id>`) to `<id>` and sent as `-m <id>`.

**Known limitation:** explicit Runtime-mode is still model-agnostic — it does not carry a specific `grok-cli/*` model id through to the adapter, so `GrokRuntimeAdapter.createSession()` falls back to `"grok/default"` and omits `-m`. Built-in Model selections preserve the model either through the direct endpoint (when a key is visible) or through the FN-7753 automatic CLI fallback (when no key is visible).

## Enable via Settings → Authentication

1. Install the `grok` CLI and authenticate it by any method it supports — Fusion does not need to see the key.
2. Open Settings → Authentication in the Fusion dashboard.
3. The "Grok — via Grok CLI" card shows probe status. Click **Enable** once the binary is available; a non-blocking hint appears only if Fusion did not detect a key, noting the direct xAI streaming path uses `GROK_API_KEY` when present.
4. Discovered Grok models (via `grok models`) then merge into the model picker under the `grok-cli` provider id.

## Notes

Do not invent a `grok status`/`whoami` JSON auth contract — readiness is derived from binary availability, mirroring the Cursor CLI provider. See `AGENTS.md`'s "External-integration evidence" policy for why the release/checksum fields above stay at `upstream-pending-verification`.
