---
"@runfusion/fusion": patch
---

summary: Fix release pipeline so binaries and desktop installers publish again.
category: fix
dev: github-release job sparse-checks-out CHANGELOG.md (was missing a checkout, so the release-notes step threw ENOENT and published 0 assets on v0.47.0); desktop esbuild build externalizes @fusion/engine so it no longer tries to bundle node-pty's native .node binaries.
