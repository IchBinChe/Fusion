---
"@runfusion/fusion": minor
"runfusion.ai": minor
"@fusion/core": minor
"@fusion/dashboard": minor
"@fusion/desktop": minor
"@fusion/engine": minor
"@fusion/mobile": minor
"@fusion/pi-claude-cli": minor
"@fusion/plugin-sdk": minor
"@fusion-plugin-examples/auto-label": minor
"@fusion-plugin-examples/ci-status": minor
"@fusion-plugin-examples/notification": minor
"@fusion-plugin-examples/settings-demo": minor
"@fusion-plugin-examples/hermes-runtime": minor
"@fusion-plugin-examples/openclaw-runtime": minor
"@fusion-plugin-examples/paperclip-runtime": minor
---

feat(runtimes): real Hermes / OpenClaw / Paperclip runtime plugins

Replaces the stub runtime plugins with end-to-end working integrations:

- **Hermes** runtime drives the local `hermes` CLI as a subprocess (`hermes chat -q ... -Q --source tool [--resume <id>]`), captures session ids for continuity, with profile picker (HERMES_HOME-based switching) and Nous Research co-brand.
- **OpenClaw** runtime drives `openclaw --no-color agent --local --json --session-id <uuid> --message <prompt>`, parses the OpenAI-compatible JSON output, surfaces visible/reasoning text via callbacks; defaults to embedded mode (no daemon required).
- **Paperclip** runtime now uses the modern `POST /api/agents/{id}/wakeup` + heartbeat-run streaming API (replaces the old issue-checkout + heartbeat-invoke flow); supports both API mode (URL + bearer) and CLI mode (auto-derives URL from `~/.paperclip/instances/default/config.json`); company + agent dropdowns; CLI key bootstrap via `paperclipai agent local-cli`.

Engine fix: `agent-session-helpers.ts:createResolvedAgentSession` now attaches the resolved runtime's `promptWithFallback` to the session so pi's dispatch hook routes prompts through the plugin runtime instead of falling through to pi's native path.

Dashboard adds a unified `RuntimeCardShell` component, real provider logos (caduceus, pixel-lobster, paperclip outline), Test/Save/Save & Test buttons with success/failure toasts, "Learn more →" links, and a "Runtimes" group in Settings.

Backend adds `GET /providers/{hermes,openclaw,paperclip}/status`, `GET /providers/hermes/profiles`, `GET /providers/paperclip/{companies,agents,cli-discovery}`, `POST /providers/paperclip/cli-mint-key`.

Plugin SDK: now ships a proper `dist/` build (was previously TS-source-only), unblocking runtime imports from compiled plugins.
