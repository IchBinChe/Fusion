---
"@runfusion/fusion": patch
---

Fix fresh-install `pnpm install` bin-link warnings by pointing the published `fn`/`fusion` bins at a committed `bin.mjs` launcher that forwards to the built CLI output.
