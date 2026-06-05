/**
 * A vault-backed Baileys auth-state — a single-blob PORT of Baileys'
 * `useMultiFileAuthState`. Where the reference scatters `creds.json` plus one file
 * per signal key across a folder, this keeps the WHOLE state (`{ creds, keys }`) in a
 * single Vesper {@link Vault} entry, serialized with `BufferJSON` (so `Buffer`/
 * `Uint8Array` key material round-trips). The blob is rewritten on every key `set`
 * and on `saveCreds`, which is more than enough for a single personal account.
 *
 * Faithful to the reference in two load-bearing details: the in-memory key store is
 * read/written through the same `{ get(type, ids), set(data) }` SignalKeyStore shape,
 * and `app-state-sync-key` values are re-wrapped through
 * `proto.Message.AppStateSyncKeyData.fromObject` on read (Baileys stores them as a
 * proto message, not a plain object).
 */

import { type Vault, VaultError } from "@vesper/core";
import {
  type AuthenticationCreds,
  type AuthenticationState,
  BufferJSON,
  initAuthCreds,
  proto,
  type SignalDataSet,
  type SignalDataTypeMap,
} from "baileys";

/** The persisted shape: creds plus the nested `category -> id -> value` key map. */
interface AuthBlob {
  creds: AuthenticationCreds;
  keys: KeyMap;
}

/** In-memory key store: `category -> id -> serialized value` (values are BufferJSON-revived). */
type KeyMap = Record<string, Record<string, unknown>>;

/** The auth state plus its persist hook, matching Baileys' `useMultiFileAuthState` return. */
export interface VaultAuthState {
  readonly state: AuthenticationState;
  readonly saveCreds: () => Promise<void>;
}

/** Is this the vault's typed "key not present yet" rejection? Anything else re-throws. */
function isNotFound(error: unknown): boolean {
  return error instanceof VaultError && error.reason === "not_found";
}

/**
 * Build a {@link Vault}-backed auth state under `key`. Loads the existing blob (or
 * seeds a fresh `initAuthCreds()` + empty key map when absent), and returns a live
 * SignalKeyStore plus a `saveCreds` that both persist the full blob.
 */
export async function makeVaultAuthState(vault: Vault, key: string): Promise<VaultAuthState> {
  const blob = await loadBlob(vault, key);
  const creds = blob.creds;
  const keys: KeyMap = blob.keys;

  const persist = async (): Promise<void> => {
    await vault.set(key, JSON.stringify({ creds, keys }, BufferJSON.replacer));
  };

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        const category = keys[type] ?? {};
        const result: { [id: string]: SignalDataTypeMap[T] } = {};
        for (const id of ids) {
          let value = category[id];
          if (value !== undefined && value !== null) {
            if (type === "app-state-sync-key") {
              value = proto.Message.AppStateSyncKeyData.fromObject(
                value as Record<string, unknown>,
              );
            }
            result[id] = value as SignalDataTypeMap[T];
          }
        }
        return result;
      },
      set: async (data: SignalDataSet) => {
        for (const category in data) {
          const entries = data[category as keyof SignalDataSet];
          if (entries === undefined) continue;
          let bucket = keys[category];
          if (bucket === undefined) {
            bucket = {};
            keys[category] = bucket;
          }
          for (const id in entries) {
            const value = entries[id];
            if (value === null || value === undefined) {
              delete bucket[id];
            } else {
              bucket[id] = value;
            }
          }
        }
        await persist();
      },
    },
  };

  return { state, saveCreds: persist };
}

/** Load + deserialize the blob, or seed a fresh one when the vault has no entry yet. */
async function loadBlob(vault: Vault, key: string): Promise<AuthBlob> {
  let raw: string;
  try {
    raw = await vault.get(key);
  } catch (error) {
    if (isNotFound(error)) {
      return { creds: initAuthCreds(), keys: {} };
    }
    throw error;
  }
  const parsed = JSON.parse(raw, BufferJSON.reviver) as Partial<AuthBlob>;
  return {
    creds: parsed.creds ?? initAuthCreds(),
    keys: parsed.keys ?? {},
  };
}
