---
"@runfusion/fusion": patch
---

Fix the Quick Chat send button going dead after switching chats on mobile. The send and stop buttons run their action on `pointerdown`/`touchstart` (iOS needs that) and set a shared `handledMobileActionRef` latch so the trailing synthetic `onClick` doesn't double-fire — but the latch was only ever cleared inside `onClick`. On iOS, `preventDefault()` in `touchstart` routinely suppresses that click, leaving the latch stuck `true`, so the next real click (e.g. after opening a different chat) was swallowed and the button appeared unresponsive. The latch is now self-clearing: it auto-resets on a short timer after each gesture and is consumed-and-cancelled when a click does fire, so it can never persist across taps. Because the ref is shared by both buttons, this also stops a stuck stop-button latch from killing the next send tap.
