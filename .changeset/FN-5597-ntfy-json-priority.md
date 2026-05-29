---
"@runfusion/fusion": patch
---

Fix ntfy JSON publish notifications to encode `priority` as the integer scale expected by ntfy so unicode mailbox/room notifications deliver successfully.
