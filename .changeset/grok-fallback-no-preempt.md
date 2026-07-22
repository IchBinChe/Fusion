---
"@runfusion/fusion": patch
---

summary: Fix grok-cli fallback models silently replacing the configured primary model when no GROK_API_KEY is visible.
category: fix
dev: The FN-7758 no-visible-key seam no longer promotes a grok-cli fallback to primary at session start; only a grok-cli primary auto-routes to the Grok CLI runtime. A fallback-only grok-cli pair without a visible key is dropped with a session warning, `grokCliFallbackDropped: true`, and reason `grok-cli-fallback-dropped-no-visible-key` in the `session:runtime-resolved` audit event, which now also records the post-transform provider/model pair the session actually runs.
