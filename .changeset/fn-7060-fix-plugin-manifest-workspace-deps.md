---
"@runfusion/fusion": patch
---

summary: Fix npm install failure caused by bundled plugins referencing private @fusion packages.
category: fix
dev: Sanitizes copied plugin and vendored extension manifests in tsup.config.ts before publishing.
