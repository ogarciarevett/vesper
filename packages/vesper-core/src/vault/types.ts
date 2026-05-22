/**
 * Secret store for pipeline-side credentials (GitHub tokens, Discord webhooks).
 * Never holds LLM auth — that lives with the user's CLI tool. Backed by the OS
 * keychain; the interface lets other platform backends drop in later.
 *
 * Every operation rejects with a `VaultError` on failure.
 */
export interface Vault {
  /** Return the stored value, or reject with `VaultError(not_found)`. */
  get(key: string): Promise<string>;
  /** Store (or overwrite) the value for `key`. */
  set(key: string, value: string): Promise<void>;
  /** Remove `key`, or reject with `VaultError(not_found)` if absent. */
  delete(key: string): Promise<void>;
  /** Return stored keys (sorted), never their values. */
  list(): Promise<string[]>;
}
