---
"@runfusion/fusion": patch
---

Fix the mobile chat keyboard collapsing the instant it opens on iOS Safari. `.chat-thread--keyboard-active` declared `transform: translateY(...)` + `will-change: transform` in CSS, keeping a non-`none` transform on `.chat-thread` — an ancestor of the focused composer textarea — for the whole keyboard-active window. iOS treats establishing that containing block over a focused input as a reason to blur it, dismissing the keyboard right after focus (with no visible jump, since `--vv-offset-top` is 0 at that moment). The drift compensation is now applied imperatively in JS only when iOS actually shifts the visual viewport (`offsetTop > 0`), so the ancestor stays `transform: none` on focus and the keyboard stays up.
