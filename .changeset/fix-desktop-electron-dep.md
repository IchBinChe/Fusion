---
"@runfusion/fusion": patch
---

summary: Fix `fusion desktop` on Windows and published npm installs (Electron dependency, GPU/sandbox flags, dashboard reuse).
category: fix
dev: `packages/cli/package.json` now depends on `electron` at runtime; previously the desktop launcher called `require("electron")`, which is only available inside the source checkout (via `pnpm-workspace.yaml` `onlyBuiltDependencies`) and is missing for npm consumers, causing `fusion desktop` to hang or fail silently. The launcher now applies GPU/sandbox-disabling Electron flags only on Windows (`os.platform() === "win32"`), keeps hardware acceleration and the Chromium sandbox on macOS/Linux, exports `FUSION_SERVER_PORT` so the desktop reuses the CLI-started dashboard instead of double-binding ports, and isolates desktop user-data under `~/.fusion/desktop-user-data`.
