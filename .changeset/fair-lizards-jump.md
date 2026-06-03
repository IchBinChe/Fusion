---
"@runfusion/fusion": patch
---

Recover failed Planning Mode session loads into the existing retryable error view instead of dropping back to the empty planner. Failed or malformed persisted planning sessions now keep their session id so Retry/Dismiss recovery remains available, while deleted sessions still quietly fall back to a new session.
