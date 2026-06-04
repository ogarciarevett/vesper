import { beforeEach, describe, expect, test } from "bun:test";
import type { ChannelHandler, ChannelPlugin, Vault } from "@vesper/core";
import type { VesperConfig } from "../config.ts";
import {
  type ConnectionsDeps,
  connectionStates,
  setEnabled,
  setToken,
  testChannel,
} from "./connections.ts";

/** An in-memory Vault double (the real one hits the macOS Keychain). */
function fakeVault(initial: Record<string, string> = {}): Vault {
  const store = new Map(Object.entries(initial));
  return {
    async get(key) {
      const v = store.get(key);
      if (v === undefined) throw new Error(`not_found: ${key}`);
      return v;
    },
    async set(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
    async list() {
      return [...store.keys()];
    },
  };
}

/** A deps builder over an in-memory config + the given vault + plugins. */
function makeDeps(opts: {
  vault: Vault;
  config?: VesperConfig;
  plugins?: readonly ChannelPlugin[];
}): { deps: ConnectionsDeps; saved: () => VesperConfig } {
  let config: VesperConfig = opts.config ?? { cli: { adapters: {} } };
  const deps: ConnectionsDeps = {
    vault: opts.vault,
    load: async () => config,
    save: async (next) => {
      config = next;
    },
    plugins: opts.plugins ?? [],
  };
  return { deps, saved: () => config };
}

/** A fake plugin whose handler records whether authenticate ran (no network). */
function fakeTelegramPlugin(onAuth: () => void, fail = false): ChannelPlugin {
  return {
    id: "telegram",
    build: () =>
      ({
        descriptor: { id: "telegram", displayName: "Telegram" },
        async authenticate() {
          onAuth();
          if (fail) throw new Error("bad token");
        },
        async send() {},
        receive: () => ({ stop() {} }),
      }) as unknown as ChannelHandler,
  };
}

describe("vesper connections — actions", () => {
  let vault: Vault;
  beforeEach(() => {
    vault = fakeVault();
  });

  test("setToken writes the credential to the vault and enables the channel", async () => {
    const { deps, saved } = makeDeps({ vault });
    const { vaultKey } = await setToken(deps, "telegram", "123:ABC");
    expect(vaultKey).toBe("telegram_bot_token");
    expect(await vault.get("telegram_bot_token")).toBe("123:ABC");
    expect(saved().connections?.telegram).toEqual({
      enabled: true,
      vaultKey: "telegram_bot_token",
      allowedHosts: ["api.telegram.org"],
    });
  });

  test("setToken rejects an empty stdin token", async () => {
    const { deps } = makeDeps({ vault });
    await expect(setToken(deps, "telegram", "")).rejects.toThrow(/no token/);
  });

  test("setToken rejects an unknown channel id", async () => {
    const { deps } = makeDeps({ vault });
    await expect(setToken(deps, "slack", "x")).rejects.toThrow(/unknown channel/);
  });

  test("setEnabled flips the flag without touching the stored token", async () => {
    const { deps, saved } = makeDeps({ vault: fakeVault({ telegram_bot_token: "keep" }) });
    await setEnabled(deps, "telegram", true);
    await setEnabled(deps, "telegram", false);
    expect(saved().connections?.telegram?.enabled).toBe(false);
    // disable must NOT delete the secret (Hard rule 4: no silent secret removal).
    expect(saved().connections?.telegram?.vaultKey).toBe("telegram_bot_token");
  });

  test("connectionStates reflects configured + enabled + availability", async () => {
    const { deps } = makeDeps({
      vault: fakeVault({ telegram_bot_token: "t" }),
      config: {
        cli: { adapters: {} },
        connections: {
          telegram: {
            enabled: true,
            vaultKey: "telegram_bot_token",
            allowedHosts: ["api.telegram.org"],
          },
        },
      },
    });
    const states = await connectionStates(deps);
    const tg = states.find((s) => s.id === "telegram");
    expect(tg).toMatchObject({ available: true, configured: true, enabled: true });
    // whatsapp ships no handler yet -> not available.
    expect(states.find((s) => s.id === "whatsapp")?.available).toBe(false);
  });

  test("testChannel builds the handler and authenticates it", async () => {
    let authed = false;
    const { deps } = makeDeps({
      vault: fakeVault({ telegram_bot_token: "t" }),
      plugins: [
        fakeTelegramPlugin(() => {
          authed = true;
        }),
      ],
    });
    const name = await testChannel(deps, "telegram");
    expect(authed).toBe(true);
    expect(name).toBe("Telegram");
  });

  test("testChannel surfaces an auth failure", async () => {
    const { deps } = makeDeps({
      vault: fakeVault({ telegram_bot_token: "bad" }),
      plugins: [fakeTelegramPlugin(() => {}, true)],
    });
    await expect(testChannel(deps, "telegram")).rejects.toThrow(/bad token/);
  });

  test("testChannel refuses a channel with no shipped handler", async () => {
    const { deps } = makeDeps({ vault });
    await expect(testChannel(deps, "whatsapp")).rejects.toThrow(/no handler/);
  });
});
