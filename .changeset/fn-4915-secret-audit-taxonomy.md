---
"@runfusion/fusion": patch
---

Expand secret audit taxonomy and harden secret audit payload handling. This adds typed secret mutation coverage (`secret:create`, `secret:update`, `secret:delete`, `secret:read`, approval events, sync events, and env lifecycle events), introduces plaintext-forbidden metadata enforcement via `assertNoSecretPlaintext`, adds non-blocking `SecretsStore` audit emitter hooks for CRUD/read operations, and ensures secret audit emission paths avoid leaking plaintext/ciphertext/nonce fields.
