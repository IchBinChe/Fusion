---
"@runfusion/fusion": patch
---

Improve dashboard shutdown observability by logging non-fatal diagnostics when `CentralCore.close()` fails during dispose, normal signal shutdown, or dev-mode shutdown cleanup.