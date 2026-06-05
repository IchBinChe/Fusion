---
"@runfusion/fusion": minor
---

Add full-screen TUI attach to cli-agent sessions (U14). The Ink dashboard TUI
can hand the terminal to a CLI agent session as a raw passthrough: it enters the
alternate screen, streams WebSocket terminal bytes to stdout and stdin keystrokes
back as input frames, propagates resizes, and ACKs consumed bytes for flow
control. The detach chord (Ctrl-]) restores the TUI cleanly, and a dropped
connection surfaces an error and restores the terminal. Untrusted terminal output
is neutralized through the same hardening filter the dashboard WS bridge uses
(OSC 52 clipboard writes, non-http(s) OSC 8 links, and device-status queries are
stripped before reaching the host TTY).
