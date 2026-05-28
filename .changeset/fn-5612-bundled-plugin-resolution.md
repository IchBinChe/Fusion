---
"@runfusion/fusion": patch
---

Fix bundled runtime plugin auto-install in globally installed CLI builds. Save/Save & Test for Paperclip, Hermes, OpenClaw, Cursor, and Droid runtime providers no longer fails with `unavailable in this build` when bundled plugins are present under `dist/plugins/<id>`.
