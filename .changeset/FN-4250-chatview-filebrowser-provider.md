---
"@runfusion/fusion": patch
---

Fix clickable file paths reliability by ensuring `FileBrowserProvider` wraps every render branch in `AppInner`, including the loader branch.
