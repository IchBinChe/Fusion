---
"@runfusion/fusion": patch
---

summary: Task-detail chat messages now use the full width in the right sidebar and narrow detail views.
category: fix
dev: TaskChatTab.css makes .task-chat-tab a `container-type: inline-size` query container and adds `@container task-chat-tab (max-width: 34rem)` collapsing the agent-header grid column and widening `.task-chat-entry--user` to 100%.
