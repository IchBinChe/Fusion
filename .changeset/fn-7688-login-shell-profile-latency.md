---
"@runfusion/fusion": patch
---

summary: Add a one-time server log hint pointing to shell-profile-hygiene docs when a login shell is slow to prompt.
category: performance
dev: FN-7688 investigated whether `--login` in `TerminalService.detectShell()`/`createSession()` is a meaningful first-prompt latency contributor. Finding: negligible on lean profiles, additive (~800ms+) when `.zprofile`/`.bash_profile` eagerly sources something slow (e.g. version manager init). `--login` is preserved unconditionally per FN-7686; added `SLOW_LOGIN_PROFILE_HINT_MS` (2000ms) threshold and a one-time, non-blocking `console.info` hint in `createSession()`'s PTY `onData` handler — never alters spawn args, timeouts, or the `retry-without-login` fallback. See `docs/solutions/developer-experience/login-shell-profile-latency.md`.
