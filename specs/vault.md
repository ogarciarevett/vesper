# SPEC: vault module (DEV-102)

## Why
Pipelines need to store their own secrets (GitHub tokens, Discord webhooks) without plaintext on
disk. Foundation backs this with the macOS Keychain via the `security` CLI, behind a `Vault`
interface so Linux/Windows backends drop in later. Vault never stores LLM auth — that lives with
the user's CLI tool.

## What changes
- New `packages/vesper-core/src/errors.ts` — `VesperError` base class (carries a stable `code`),
  the shared error shape every module extends.
- New `packages/vesper-core/src/process/run.ts` — `runProcess(command, args, opts)` →
  `{ stdout, stderr, exitCode, durationMs }`. The single `Bun.spawn` seam; mockable so no real
  process runs in dependent unit tests.
- New `packages/vesper-core/src/vault/` — `Vault` interface (`get/set/delete/list`),
  `KeychainVault` (security-CLI backend), `VaultError` (reasons: `not_found`, `permission_denied`,
  `keychain_unavailable`).

## Design decisions
- KeychainVault SHALL shell out to `security` only (no keytar, no native deps). Entries use
  service `vesper` and account = the caller's key.
- `set` → `security add-generic-password -U` (update-or-add); `get` → `find-generic-password -w`;
  `delete` → `delete-generic-password`.
- `list` SHALL read a maintained index entry (`vesper`/`__keys__`, a JSON array) rather than
  `dump-keychain`, because `security` has no "enumerate accounts for a service" verb. `set`/`delete`
  keep the index in sync. `list` returns keys only, never values, and excludes `__keys__`.
- KeychainVault takes an injectable `ProcessRunner` (defaults to `runProcess`) so tests mock the
  shell-out — no real Keychain writes in the suite.
- Error mapping: exit 44 / stderr "could not be found" → `not_found`; stderr
  "authorization"/"denied" → `permission_denied`; runner ENOENT (security missing) →
  `keychain_unavailable`.

## Out of scope
Linux/Windows backends; secret rotation; DB encryption; an integrity-checked index (Foundation
trusts the single-process index).

## Acceptance (SHALL)
- GIVEN `set(k, v)` WHEN `get(k)` THEN returns exactly `v`.
- GIVEN `set(k, v)` then `delete(k)` WHEN `get(k)` THEN throws `VaultError` with `reason="not_found"`.
- GIVEN no entry for `k` WHEN `get(k)` THEN throws `VaultError(not_found)`.
- GIVEN `security` reports an authorization failure WHEN any op THEN `VaultError(permission_denied)`.
- GIVEN `security` is not installed WHEN any op THEN `VaultError(keychain_unavailable)`.
- GIVEN `set("a")`, `set("b")` WHEN `list()` THEN returns `["a","b"]` (sorted), never values,
  excluding the internal index key.
- `bun test` ≥80% line coverage on `vault/` (+ `process/run.ts`, `errors.ts`).
