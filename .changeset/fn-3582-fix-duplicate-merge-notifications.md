---
"@runfusion/fusion": patch
---

Fix duplicate ntfy merge notifications by ensuring `ProjectEngine` uses a single `NotificationService` listener graph and passes that shared service into the `NtfyNotifier` compatibility shim.
