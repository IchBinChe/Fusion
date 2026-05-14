---
"@runfusion/fusion": patch
---

Add experiment session finalize workflow across engine, CLI, extension, and dashboard API. The workflow previews and finalizes kept experiment runs into reviewable branches from merge-base, with typed error mapping for CLI/API consumers and rollback on partial branch creation failures.
