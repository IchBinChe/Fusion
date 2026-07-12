---
"@runfusion/fusion": patch
---

summary: Priority selection in quick add and task cards is now color-coded by urgency (blue low, amber high, red urgent).
category: feature
dev: priorityIndicator gains a getPriorityColorVar single source consumed by QuickEntryBox, TaskForm inline row, and TaskCard's .card-priority-badge; semantic tokens only, no test-id/payload changes.
