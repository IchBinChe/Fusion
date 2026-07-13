---
"@runfusion/fusion": minor
---

summary: Switch an active chat's model or agent mid-conversation from the brain-icon popup.
category: feature
dev: Extends PATCH /api/chat/sessions/:id with validated modelProvider+modelId and agentId, adds chat-store updateSession agentId clause, useChat.setSessionModel, and a Model/Agent section in the brain popup (ChatThinkingLevelControl).
