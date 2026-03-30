---
"@dustinbyrne/kb": patch
---

Fix mobile touch sensitivity on dashboard cards

Implements touch gesture detection to distinguish between scrolling/dragging and intentional taps. Cards now only open the detail modal on quick taps (< 300ms) with minimal movement (< 10px). This prevents accidental modal opens when users are scrolling through the kanban board on mobile devices.
