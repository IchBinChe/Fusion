---
"@runfusion/fusion": patch
---

summary: Task detail toolbar is now icon-only and matches Quick Add — fixes the mis-sized oversight icon on mobile.
category: fix
dev: TaskDetailModal inline controls converted to icon-only btn-icon btn-sm (oversight Eye, flag priority trigger with dropdown, Zap fast toggle); removed bespoke svg 1em sizing so icons use the shared --icon-size-sm token. Reuses handleInlinePriorityChange/handleInlineExecutionModeToggle and existing oversight/GitHub/attach handlers.
