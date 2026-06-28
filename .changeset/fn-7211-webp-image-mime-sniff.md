---
"@runfusion/fusion": patch
---

summary: Fix planning/chat failures when image attachment bytes do not match the file extension.
category: fix
dev: Adds detectImageMimeFromBytes in core and applies it in triage and dashboard chat attachment read paths.
