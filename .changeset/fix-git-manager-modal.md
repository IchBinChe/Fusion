---
"@gsxdsm/fusion": patch
---

Fix Git Manager dialog rendering off-screen on smaller viewports

Changed `.gm-content` min-height from 400px to 0, allowing the modal content
to properly flex within the viewport instead of forcing overflow.
