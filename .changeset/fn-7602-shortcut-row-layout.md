---
"@runfusion/fusion": patch
---

summary: Fix overlapping Record and Clear buttons in the Keyboard Shortcuts settings rows on desktop and mobile.
category: fix
dev: The shortcut-capture Record/Clear buttons no longer use the icon-only `btn-icon` class (which set `line-height:0` and a mobile 36px square, clipping/overlapping the text labels); they use a text-button class and the `.shortcut-capture` row locks buttons with `flex-shrink:0` so the input and controls never overlap, stacking cleanly on mobile.
