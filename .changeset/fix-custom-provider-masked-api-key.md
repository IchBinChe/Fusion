---
"@runfusion/fusion": patch
---

Fix custom provider message sends failing with a `ByteString` error (`character ... value 8226`). The settings UI displays the saved API key masked with `•` characters; saving the provider without retyping the key persisted that mask as the real credential, which then broke HTTP header encoding. Masked values echoed back on update are now treated as "unchanged" and the stored key is preserved; masked values on create/probe are rejected.

The edit form no longer seeds the API key field with the masked value at all — it starts blank (with a "Leave blank to keep current key" hint) so the mask can never be echoed back to save or "Detect Models". Existing keys are preserved when the field is left empty.
