---
"@runfusion/fusion": patch
---

summary: Keep Anthropic subscription OAuth, Claude CLI, and direct API-key auth separated.
category: fix
dev: Restores anthropic-subscription status/usage/banner behavior and direct subscription-backed execution while keeping raw anthropic API-key auth and explicit pi-claude-cli execution separate.
