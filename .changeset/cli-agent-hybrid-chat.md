---
"@runfusion/fusion": minor
---

CLI-agent hybrid chat (U12): a chat session can select a cli-agent executor and
be driven by a long-lived CLI agent process. Adapter transcript telemetry maps
to durable chat_messages rows at user/assistant/tool-summary granularity (raw
tool noise stays in the terminal), with the shared `redactSecrets` pass applied
before persistence so transcripts never become a secret store. Composer sends
route through the inject path with FIFO queueing; the flush decision re-fetches
authoritative session state rather than trusting a cached busy flag. The chat
surface gains a transcript ↔ raw-terminal toggle (terminal owns input, composer
hidden in terminal mode); generic-tier sessions render terminal-only with no
toggle. New per-session `cliExecutorAdapterId` linkage on chat_sessions.
