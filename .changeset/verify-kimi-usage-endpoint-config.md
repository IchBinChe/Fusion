---
"@gsxdsm/fusion": patch
---

Verify and lock Kimi usage endpoint configuration with regression tests. The underscore endpoint (`/v1/coding_plan/usage`) is primary (Codexbar-validated), with hyphen endpoint (`/v1/coding-plan/usage`) as legacy fallback. Error handling: 401/403 short-circuits immediately, 404 triggers fallback to alternate endpoint, final 404 `url.not_found` returns sanitized error message without leaking raw upstream JSON.
