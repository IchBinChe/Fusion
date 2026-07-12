---
"@runfusion/fusion": patch
---

summary: Fix the mobile Todo view so the list panel fills full height on selection.
category: fix
dev: TodoView.css — the single-panel narrow-container stack no longer inherits the @media (max-width:768px) sidebar max-height cap.
