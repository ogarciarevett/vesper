import { describe, expect, test } from "bun:test";
import { type Capability, type Vault, VaultError } from "@vesper/core";
import { normalizeConfig, type VesperConfig } from "./config.ts";
import {
  defaultVaultKey,
  makeEmbedder,
  PROVIDER_PRIORITY,
  resolveEmbeddings,
} from "./embeddings.ts";

const NET: readonly Capability[] = ["NETWORK_FETCH"];

function fakeVault(entries: Record<string, string> = {}): Vault {
  const store: Record<string, string> = { ...entries };
  return {
    async get(key) {
      const value = store[key];
      if (value === undefined) throw new VaultError("not_found", `no entry for ${key}`);
      return value;
    },
    async set(key, value) {
      store[key] = value;
    },
    async delete(key) {
      delete store[key];
    },
    async list() {
      return Object.keys(store).sort();
    },
  };
}

describe("normalizeConfig embeddings", () => {
  test("keeps a recognized provider with overrides", () => {
    const cfg = normalizeConfig({
      cli: { adapters: {} },
      embeddings: { provider: "openai", model: "m", dimensions: 256, vaultKey: "k" },
    });
    expect(cfg.embeddings).toEqual({
      provider: "openai",
      model: "m",
      dimensions: 256,
      vaultKey: "k",
    });
  });

  test("drops an unrecognized provider", () => {
    const cfg = normalizeConfig({ cli: { adapters: {} }, embeddings: { provider: "bogus" } });
    expect(cfg.embeddings).toBeUndefined();
  });

  test("drops a non-positive dimensions override", () => {
    const cfg = normalizeConfig({
      cli: { adapters: {} },
      embeddings: { provider: "ollama", dimensions: -1 },
    });
    expect(cfg.embeddings).toEqual({ provider: "ollama" });
  });
});

describe("resolveEmbeddings", () => {
  test("null when unconfigured", () => {
    expect(resolveEmbeddings({ cli: { adapters: {} } })).toBeNull();
  });

  test("ollama defaults (local, no key)", () => {
    const r = resolveEmbeddings({ cli: { adapters: {} }, embeddings: { provider: "ollama" } });
    expect(r?.id).toBe("ollama:nomic-embed-text");
    expect(r?.dimensions).toBe(768);
    expect(r?.needsKey).toBe(false);
    expect(r?.allowedHosts).toContain("localhost");
  });

  test("openai defaults need a key", () => {
    const r = resolveEmbeddings({ cli: { adapters: {} }, embeddings: { provider: "openai" } });
    expect(r?.dimensions).toBe(1536);
    expect(r?.needsKey).toBe(true);
    expect(r?.vaultKey).toBe(defaultVaultKey("openai"));
  });

  test("overrides endpoint/model/dimensions and allowlists the custom host", () => {
    const r = resolveEmbeddings({
      cli: { adapters: {} },
      embeddings: {
        provider: "ollama",
        endpoint: "http://box.local:1234",
        model: "mxbai",
        dimensions: 512,
      },
    });
    expect(r?.model).toBe("mxbai");
    expect(r?.dimensions).toBe(512);
    expect(r?.id).toBe("ollama:mxbai");
    expect(r?.allowedHosts).toContain("box.local");
  });
});

describe("makeEmbedder", () => {
  const cfgOllama: VesperConfig = { cli: { adapters: {} }, embeddings: { provider: "ollama" } };
  const cfgOpenai: VesperConfig = { cli: { adapters: {} }, embeddings: { provider: "openai" } };

  test("null when unconfigured", async () => {
    expect(await makeEmbedder({ cli: { adapters: {} } }, fakeVault(), NET)).toBeNull();
  });

  test("builds an ollama embedder without consulting the vault", async () => {
    const e = await makeEmbedder(cfgOllama, fakeVault(), NET);
    expect(e?.id).toBe("ollama:nomic-embed-text");
    expect(e?.dimensions).toBe(768);
  });

  test("builds an openai embedder from the vault key", async () => {
    const e = await makeEmbedder(
      cfgOpenai,
      fakeVault({ [defaultVaultKey("openai")]: "sk-x" }),
      NET,
    );
    expect(e?.id).toBe("openai:text-embedding-3-small");
    expect(e?.dimensions).toBe(1536);
  });

  test("null when the required key is missing (graceful)", async () => {
    expect(await makeEmbedder(cfgOpenai, fakeVault(), NET)).toBeNull();
  });
});

test("PROVIDER_PRIORITY is local-first", () => {
  expect(PROVIDER_PRIORITY[0]).toBe("ollama");
});
