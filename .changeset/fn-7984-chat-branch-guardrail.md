---
"@runfusion/fusion": patch
---

summary: Chat agents no longer switch your checked-out branch unless you ask.
category: fix
dev: Adds a branch-stickiness clause to CHAT_SYSTEM_PROMPT in packages/dashboard/src/chat.ts.
