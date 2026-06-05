---
"@runfusion/fusion": minor
---

CLI agent terminal UI (U11): a shared `SessionTerminal` component (lazy-loaded
xterm + fit/webgl/unicode11) that attaches to the U10 cli-sessions WebSocket
with ACK flow control, a posture chip (baseline vs elevated), a read-only
badge, session-idle/ended replay states, and a generic-tier confirm-advance
strip. Adds a `terminal` tab to the task detail view driven by the lifecycle
visibility matrix (live / read-only live / replay-idle / replay-ended / hidden)
with live `cli:session:state` SSE merging, waiting-on-input and needs-attention
task-card badges (distinct from staleness/stall badges), and extends
`SessionNotificationBanner` with a `cli-agent` session type plus the pinned
needs-attention variants (userExited / authFailed / resume-exhausted) and their
actions. All new strings flow through the i18n catalogs.
