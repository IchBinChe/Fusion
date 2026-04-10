---
"@gsxdsm/fusion": patch
---

Fix Kimi usage endpoint 404 error message sanitization. When both Kimi endpoints return 404 with `url.not_found` error, the error message is now sanitized to a clean, actionable message instead of leaking raw upstream JSON payloads to users.
