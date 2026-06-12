---
"@runfusion/fusion": patch
---

Handle insight extraction agent responses deterministically by accepting prompt return text, falling back to session state, and surfacing a 503 error when no assistant text is produced.
