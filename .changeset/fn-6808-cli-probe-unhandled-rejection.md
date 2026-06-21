---
"@runfusion/fusion": patch
---

Prevent bundled Droid and Claude CLI auth/presence probes from surfacing unhandled promise rejections when `spawn` throws synchronously, such as when test guards block real AI CLI auth commands. These probes now resolve as unavailable/unauthenticated instead of rejecting from fire-and-forget validation paths.
