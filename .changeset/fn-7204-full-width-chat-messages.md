---
"@runfusion/fusion": patch
---

summary: Chat messages now use the full width in narrow popup and sidebar chats.
category: fix
dev: ChatView.css adds a `@container chat-view (max-width: 30rem)` rule setting `.chat-message` to max-width:100%, plus the mobile viewport rule bumped from 90% to 100%.
