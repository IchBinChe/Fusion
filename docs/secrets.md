# Secrets

[← Docs index](./README.md)

## Overview

Fusion's secrets subsystem provides encrypted-at-rest secret storage with project scope (`.fusion/fusion.db`) and global scope (`~/.fusion/fusion-central.db`).

Current shipped behavior in this branch includes:

- AES-256-GCM encryption primitives (`packages/core/src/secrets-crypto.ts`)
- CRUD + reveal APIs via `SecretsStore` (`packages/core/src/secrets-store.ts`)
- Per-secret access policy metadata (`auto` / `prompt` / `deny`)
- Schema-backed read metadata (`last_read_at`, `last_read_by`)

Threat-model baseline:

- Secret plaintext is **not** stored in SQLite.
- Ciphertext + nonce are persisted; plaintext exists only in process memory during create/reveal.
- Secret values must never be logged.

See also: [Storage](./storage.md), [Multi-project](./multi-project.md), [Architecture](./architecture.md), [Settings reference](./settings-reference.md).

## Architecture

Fusion stores secrets in two SQLite tables:

- Project scope: `secrets` in `.fusion/fusion.db`
- Global scope: `secrets_global` in `~/.fusion/fusion-central.db`

Both tables share the same column contract:

| Column | Type | Notes |
|---|---|---|
| `id` | `TEXT` | Primary key UUID. |
| `key` | `TEXT` | Unique secret key (`idxSecretsKey` / `idxSecretsGlobalKey`). |
| `value_ciphertext` | `BLOB` | AES-GCM ciphertext payload (includes auth tag). |
| `nonce` | `BLOB` | Per-row random nonce. |
| `description` | `TEXT` | Optional metadata. |
| `access_policy` | `TEXT` | `CHECK` constrained to `auto`, `prompt`, `deny`. |
| `env_exportable` | `INTEGER` | `0/1` flag for env-materialization intent metadata. |
| `env_export_key` | `TEXT` | Optional env variable key metadata. |
| `created_at` | `TEXT` | ISO timestamp. |
| `updated_at` | `TEXT` | ISO timestamp. |
| `last_read_at` | `TEXT` | Last reveal timestamp. |
| `last_read_by` | `TEXT` | Agent/user identifier recorded on reveal. |

For broader database inventory, see [docs/storage.md](./storage.md).

## Encryption

Secret crypto uses AES-256-GCM with:

- 32-byte master key
- 12-byte random nonce per encrypt operation
- 16-byte auth tag appended to ciphertext

Implementation reference: `packages/core/src/secrets-crypto.ts`.

## Master Key Resolution

The current implementation exposes a `MasterKeyProvider` abstraction consumed by `createSecretCipher` / `SecretsStore`.

- Required contract: async provider that returns a **32-byte** key.
- Validation failures return non-sensitive `SecretCryptoError` codes.

⚠️ Runtime keychain/filesystem resolution and rotation workflow are not yet wired in this branch. Track follow-up: **FN-4867**.

## Access Policies

Per-secret policy values are:

- `auto`
- `prompt`
- `deny`

Resolution helper (`resolveSecretAccessPolicy`) uses:

1. Row-level secret policy (if set)
2. Global settings default `secretsAccessPolicy` (if set)
3. Fallback: `prompt`

Implementation references:

- `packages/core/src/secret-access-policy.ts`
- `packages/core/src/types.ts` (`GlobalSettings.secretsAccessPolicy`)

⚠️ Approval API integration (`POST /api/approvals/:id/decision`) for secret reads is not yet wired in this branch. Track follow-up: **FN-4867**.

## Dashboard CRUD

⚠️ A dedicated dashboard `SecretsView` is not present in this branch. Secret CRUD currently exists at the core store layer only. Track follow-up: **FN-4867**.

## Agent Access (`fn_secret_get`)

⚠️ The `fn_secret_get` pi-extension tool is not present in `packages/cli/src/extension.ts` in this branch. Any tool signature, resolution order, and runtime return contract remain pending implementation. Track follow-up: **FN-4867**.

## `.env` Auto-write into Worktrees

The schema already carries env-materialization metadata (`env_exportable`, `env_export_key`) per secret.

⚠️ Engine-side `.env` materialization settings and provisioning hooks (for example `secretsEnv.*`, overwrite policy, gitignore gating, teardown fingerprint cleanup) are not implemented in this branch. Track follow-up: **FN-4867**.

## Cross-node Sync

Fusion now exposes four secrets sync endpoints:

- `POST /api/nodes/:id/secrets/push` — wraps local secrets into a passphrase-protected envelope and sends it to a remote node.
- `POST /api/nodes/:id/secrets/pull` — fetches a remote envelope from `GET /api/secrets/sync-export` and applies it locally.
- `POST /api/secrets/sync-receive` — inbound apply endpoint (Bearer `apiKey` required).
- `GET /api/secrets/sync-export` — inbound export endpoint (Bearer `apiKey` required).

Envelope format is `WrappedSecretsBundle` from `packages/core/src/secrets-sync.ts`: `{ version, ciphertext, salt, nonce, kdf, kdfParams }` plus transport metadata (`sourceNodeId`, `exportedAt`). Wrapping uses scrypt (`N=32768, r=8, p=1, keyLen=32`) and AES-256-GCM with fresh 12-byte nonce + 16-byte salt per export. `TODO(FN-4867)` remains for planned Argon2id migration.

Sync passphrase storage is local-only: reserved key `__sync_passphrase__` in `secrets_global` with `access_policy="deny"` and `env_exportable=false`, encrypted under the local master key. The passphrase is never transmitted and never returned by HTTP endpoints.

Error mapping:

- `SecretsSyncError` codes (`wrong-passphrase`, `version-mismatch`, `malformed`) return HTTP `400` with `{ "error": <code> }`.
- Missing passphrase returns HTTP `400` with `{ "error": "passphrase-not-configured" }`.
- Bearer auth failures return HTTP `401`.

Audit events emitted on apply/send paths:

- `secret:sync-push`
- `secret:sync-pull`

Audit payloads exclude plaintext values, passphrases, and envelope crypto material (`ciphertext`, `salt`, `nonce`).

## Audit Events

Filesystem-domain secret audit taxonomy:

- `secret:read`
- `secret:create`
- `secret:update`
- `secret:delete`
- `secret:approval-requested`
- `secret:approval-granted`
- `secret:approval-denied`
- `secret:sync-push`
- `secret:sync-pull`
- `secret:env-write`
- `secret:env-write-skipped`
- `secret:env-cleanup`
- `secret:env-cleanup-skipped`

Wired in this branch/task lineage: `secret:read`, `secret:create`, `secret:update`, `secret:delete`, and approval events (`secret:approval-requested`, `secret:approval-granted`, `secret:approval-denied`).

Pending follow-ups:
- Sync endpoint/event integration details continue under **FN-4913** (`secret:sync-push`, `secret:sync-pull`).
- Env materialization lifecycle wiring continues under **FN-4912** (`secret:env-*`).

**Plaintext prohibition:** audit payload metadata must never include plaintext, decrypted values, ciphertext, or nonce fields. Use `assertNoSecretPlaintext(...)` as the canonical enforcement helper before emitting secret audit events.

## Operational Notes

- Backups: preserve both SQLite data and master-key material/provider source used by deployment.
- If master key material is lost, encrypted secret values become unrecoverable.
- Out-of-scope / pending integration items for this branch:
  - Full runtime master-key management + rotation UX
  - `fn_secret_get` tool surface
  - Worktree `.env` materialization pipeline
  - Cross-node secret sync endpoints/passphrase exchange
  - Advanced capabilities (TTL/rotation automation, env-set profiles, KMS/Vault backends, per-node asymmetric sync)
