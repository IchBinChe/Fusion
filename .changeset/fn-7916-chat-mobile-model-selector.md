---
"@runfusion/fusion": patch
---

summary: Fix the in-chat model selector on tablet and mobile.
category: fix
dev: The brain popup's pointerdown outside-close now treats the portaled CustomModelDropdown menu (.model-combobox-dropdown--portal) as inside, so a model tap registers instead of closing the popup; ChatView.css re-anchors the mobile popover to fit the viewport. CustomModelDropdown is unchanged.
