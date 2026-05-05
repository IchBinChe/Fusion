---
"@runfusion/fusion": patch
---

Reduce log noise: bump `checkForChanges` slow-poll warn threshold from 100ms to 750ms (the 1s poll interval + multiple SQLite queries routinely exceed 100ms without indicating a real problem), and route skill-resolver `info` diagnostics (e.g. "Requested skill: …") through `log()` instead of `warn()` so informational messages no longer surface as warnings.
