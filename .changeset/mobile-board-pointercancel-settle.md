---
"@runfusion/fusion": patch
---

summary: Fix mobile board drags resting between columns, edge-column snap-back glitches, and fling overshoot past the mostly-visible column.
category: fix
dev: useColumnScrollSnap now ignores pointercancel while the touch stream is still live (native scroll takeover), and settle targets the nearest column clamped to one column of progress from the gesture origin (resolveSettleTargetIndex) instead of always paging past it.
