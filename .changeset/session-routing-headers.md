---
"@runfusion/fusion": minor
---

Add `X-Session-Id` and `X-Session-Affinity` request headers to all LLM chat completion requests. These let LLM gateways sticky-route consecutive requests from the same conversation to the same backend, and let observability tools (Langfuse, Arize, etc.) group the otherwise-stateless API calls of a session into a single multi-turn trace. Both headers carry the same stable identifier — the task id when available (stable across pause/resume), otherwise the pi session id. (#1675)
