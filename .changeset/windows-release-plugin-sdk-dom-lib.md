---
"@fusion/plugin-sdk": patch
---

Fix Windows binary-release build failure: add the DOM lib to `@fusion/plugin-sdk`'s tsconfig. Because `@fusion/core` exports its types as raw `src/*.ts`, plugin-sdk recompiles core's source under its own compiler options; without the DOM lib the global fetch `Response` type (`.ok`/`.status`/`.json`) resolved inconsistently across platforms and broke the Windows CLI and desktop release jobs (TS2339).
