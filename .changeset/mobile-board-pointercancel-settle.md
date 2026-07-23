---
"@runfusion/fusion": patch
---

summary: Fix the mobile board resting between columns after a drag and edge-column snap-back glitches during slow scrolls.
category: fix
dev: useColumnScrollSnap now ignores pointercancel while the touch stream is still live (native scroll takeover); touchend remains the real finger lift, so gestures are neither orphaned nor idle-settled mid-drag.
