---
"@fusion/core": patch
---

Stop `MasterKeyManager` from probing the real macOS/Linux keychain during tests. A new `FUSION_MASTER_KEY_DISABLE_KEYCHAIN=1` env var forces the file backend, and the core vitest setup sets it so tests no longer hang for 15s in `keytar.getPassword(...)` on machines without a usable keychain.
