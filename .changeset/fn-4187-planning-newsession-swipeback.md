---
"@runfusion/fusion": patch
---

Fix mobile swipe-back from the Planning modal's "New Session" path: opening a new planning session on mobile now registers a back-stack entry so swipe-back returns to the planning sessions list instead of closing the modal.
