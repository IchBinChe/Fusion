---
"@runfusion/fusion": patch
---

summary: Fix the mobile task detail panel being shifted left with a dead gutter on the right.
category: fix
dev: The full-screen mobile task-detail sheet hides all resize handles, so FN-8015's `margin-inline-end: var(--space-lg)` scrollbar/resize-hot-zone gutter on the shared `.floating-window__body` only added dead space on the right. Zeroed it for `.floating-window--task-detail` inside the mobile breakpoint; desktop resize-handle clearance is untouched.
