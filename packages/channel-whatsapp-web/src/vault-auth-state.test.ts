import { describe, expect, test } from "bun:test";
import { type Vault, VaultError } from "@vesper/core";
import { makeVaultAuthState } from "./vault-auth-state.ts";

/** An in-memory {@link Vault} that throws `VaultError(not_found)` for an absent key. */
function memoryVault(seed?: Record<string, string>): Vault & { store: Map<string, string> } {
  const store = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    store,
    get: async (key) => {
      const value = store.get(key);
      if (value === undefined) throw new VaultError("not_found", `no ${key}`);
      return value;
    },
    set: async (key, value) => {
      store.set(key, value);
    },
    delete: async (key) => {
      if (!store.delete(key)) throw new VaultError("not_found", `no ${key}`);
    },
    list: async () => [...store.keys()].sort(),
  };
}

const KEY = "whatsapp_web_session";

describe("makeVaultAuthState", () => {
  test("seeds fresh creds when the vault has no entry", async () => {
    const vault = memoryVault();
    const { state } = await makeVaultAuthState(vault, KEY);
    expect(state.creds.registered).toBe(false);
    // initAuthCreds gives a noiseKey with Buffer/Uint8Array material.
    expect(state.creds.noiseKey.private.length).toBeGreaterThan(0);
    // Nothing persisted until a set/saveCreds happens.
    expect(vault.store.has(KEY)).toBe(false);
  });

  test("saveCreds persists the blob and a reload yields the same registrationId", async () => {
    const vault = memoryVault();
    const first = await makeVaultAuthState(vault, KEY);
    await first.saveCreds();
    expect(vault.store.has(KEY)).toBe(true);

    const reloaded = await makeVaultAuthState(vault, KEY);
    expect(reloaded.state.creds.registrationId).toBe(first.state.creds.registrationId);
  });

  test("key store round-trips a set value through a reload (Buffers survive BufferJSON)", async () => {
    const vault = memoryVault();
    const { state } = await makeVaultAuthState(vault, KEY);
    const keyId = "5";
    const material = {
      public: new Uint8Array([1, 2, 3, 4]),
      private: new Uint8Array([5, 6, 7, 8]),
    };
    await state.keys.set({ "pre-key": { [keyId]: material } });
    expect(vault.store.has(KEY)).toBe(true);

    const reloaded = await makeVaultAuthState(vault, KEY);
    const got = await reloaded.state.keys.get("pre-key", [keyId]);
    expect(got[keyId]).toBeDefined();
    expect([...(got[keyId] as { public: Uint8Array }).public]).toEqual([1, 2, 3, 4]);
    expect([...(got[keyId] as { private: Uint8Array }).private]).toEqual([5, 6, 7, 8]);
  });

  test("set with a null value deletes the key", async () => {
    const vault = memoryVault();
    const { state } = await makeVaultAuthState(vault, KEY);
    await state.keys.set({ session: { a: new Uint8Array([9]) } });
    await state.keys.set({ session: { a: null } });
    const got = await state.keys.get("session", ["a"]);
    expect(got.a).toBeUndefined();
  });

  test("app-state-sync-key values are re-wrapped as proto on read", async () => {
    const vault = memoryVault();
    const { state } = await makeVaultAuthState(vault, KEY);
    await state.keys.set({
      "app-state-sync-key": { k1: { keyData: new Uint8Array([1]), fingerprint: {}, timestamp: 0 } },
    });
    const reloaded = await makeVaultAuthState(vault, KEY);
    const got = await reloaded.state.keys.get("app-state-sync-key", ["k1"]);
    // proto.Message.AppStateSyncKeyData.fromObject produces an object with a toJSON method.
    expect(got.k1).toBeDefined();
    expect(typeof (got.k1 as { toJSON?: unknown }).toJSON).toBe("function");
  });
});
