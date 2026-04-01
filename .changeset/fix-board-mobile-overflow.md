---
"@gsxdsm/fusion": patch
---

Fix board bottom overflow on mobile devices by using `100dvh` instead of `100vh` for proper dynamic viewport handling. This prevents the board from extending below the visible viewport on devices with collapsing browser chrome.
