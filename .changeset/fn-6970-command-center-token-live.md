---
"@runfusion/fusion": patch
---

summary: Fix Command Center token usage updating live without manual refresh.
category: fix
dev: Analytics polling now revalidates in the background when prior data exists so token cards, charts, and model rows stay mounted during live refresh.
