---
"@runfusion/fusion": patch
---

Upgrade `@mariozechner/pi-ai` and `@mariozechner/pi-coding-agent` from `^0.72.1` to `^0.73.0` across cli, engine, and dashboard. pi-ai 0.73 also extracts the underlying `ErrorEvent.error` cause for Codex WebSocket failures, complementing our local transient-retry classifier.
