---
"@runfusion/fusion": patch
---

summary: Fix bundled example plugins failing to enable with a missing @fusion/core package error.
category: fix
dev: Aliases bundlePluginEntry @fusion/core imports to pluginSdkCoreRuntimeShim for self-contained bundled.js outputs.
