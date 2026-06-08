/**
 * Host-side bridge from config + vault to the core RAG {@link Embedder} (specs/rag-memory.md).
 * Bring-your-own: a local server (Ollama, no key) or an OpenAI-compatible endpoint (OpenAI /
 * Voyage) whose key lives in the vault. Per-provider defaults are merged with config overrides;
 * the embedder reaches ONLY the resolved provider host (allowlisted) and asserts NETWORK_FETCH.
 */

import {
  type Capability,
  type Embedder,
  type EmbedderFormat,
  makeHttpEmbedder,
  openRagIndex,
  type RagHit,
  type RagStatus,
  ragSearch,
  ragStatus,
  type Store,
  type Vault,
  VaultError,
} from "@vesper/core";
import type { EmbeddingsProvider, VesperConfig } from "./config.ts";

/**
 * Capabilities the host grants to RAG operations (CLI + daemon). The RAG seams assert
 * these before any storage read/write or network egress — one source of truth so the
 * `vesper rag` CLI and the daemon's in-process index grant identically.
 */
export const RAG_CAPABILITIES: readonly Capability[] = [
  "READ_STORAGE",
  "WRITE_STORAGE",
  "NETWORK_FETCH",
  "FS_READ",
];

interface ProviderDefault {
  readonly format: EmbedderFormat;
  readonly endpoint: string;
  readonly hosts: readonly string[];
  readonly model: string;
  readonly dimensions: number;
  readonly needsKey: boolean;
}

/** Per-provider defaults; config may override endpoint/model/dimensions/vaultKey. */
export const PROVIDER_DEFAULTS: Readonly<Record<EmbeddingsProvider, ProviderDefault>> = {
  ollama: {
    format: "ollama",
    endpoint: "http://localhost:11434",
    hosts: ["localhost", "127.0.0.1"],
    model: "nomic-embed-text",
    dimensions: 768,
    needsKey: false,
  },
  openai: {
    format: "openai",
    endpoint: "https://api.openai.com",
    hosts: ["api.openai.com"],
    model: "text-embedding-3-small",
    dimensions: 1536,
    needsKey: true,
  },
  voyage: {
    format: "openai",
    endpoint: "https://api.voyageai.com",
    hosts: ["api.voyageai.com"],
    model: "voyage-3-lite",
    dimensions: 512,
    needsKey: true,
  },
};

/** Preference order when auto-selecting a provider during setup/onboarding (local-first). */
export const PROVIDER_PRIORITY: readonly EmbeddingsProvider[] = ["ollama", "openai", "voyage"];

/** The default vault-entry name for a provider's API key. */
export function defaultVaultKey(provider: EmbeddingsProvider): string {
  return `embeddings_${provider}_key`;
}

/** Concrete, resolved embedder settings (provider defaults merged with config overrides). */
export interface ResolvedEmbeddings {
  readonly provider: EmbeddingsProvider;
  readonly format: EmbedderFormat;
  readonly endpoint: string;
  readonly model: string;
  readonly dimensions: number;
  readonly allowedHosts: readonly string[];
  readonly needsKey: boolean;
  readonly vaultKey: string;
  /** Stable id persisted per indexed row, e.g. "ollama:nomic-embed-text". */
  readonly id: string;
}

function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Resolve the active embeddings settings from config, or null when none configured. */
export function resolveEmbeddings(config: VesperConfig): ResolvedEmbeddings | null {
  const cfg = config.embeddings;
  if (cfg === undefined) return null;
  const def = PROVIDER_DEFAULTS[cfg.provider];
  const endpoint = cfg.endpoint ?? def.endpoint;
  const model = cfg.model ?? def.model;
  const dimensions = cfg.dimensions ?? def.dimensions;
  const vaultKey = cfg.vaultKey ?? defaultVaultKey(cfg.provider);
  // Allowlist the provider defaults plus the resolved endpoint's host (so a custom endpoint works).
  const hosts = new Set<string>(def.hosts);
  const host = hostnameOf(endpoint);
  if (host !== undefined) hosts.add(host);
  return {
    provider: cfg.provider,
    format: def.format,
    endpoint,
    model,
    dimensions,
    allowedHosts: [...hosts],
    needsKey: def.needsKey,
    vaultKey,
    id: `${cfg.provider}:${model}`,
  };
}

/**
 * Build the core {@link Embedder} from config + vault, or null when RAG is not usable (no
 * provider configured, or a required API key is missing from the vault). Degrades gracefully
 * rather than throwing, so the Memory surface can show "not enabled" instead of crashing.
 */
export async function makeEmbedder(
  config: VesperConfig,
  vault: Vault,
  granted: readonly Capability[],
): Promise<Embedder | null> {
  const resolved = resolveEmbeddings(config);
  if (resolved === null) return null;

  let apiKey: string | undefined;
  if (resolved.needsKey) {
    try {
      apiKey = await vault.get(resolved.vaultKey);
    } catch (err) {
      if (err instanceof VaultError) return null; // key not set yet -> degrade to unavailable
      throw err;
    }
  }

  return makeHttpEmbedder({
    id: resolved.id,
    format: resolved.format,
    endpoint: resolved.endpoint,
    model: resolved.model,
    dimensions: resolved.dimensions,
    allowedHosts: resolved.allowedHosts,
    granted,
    ...(apiKey !== undefined ? { apiKey } : {}),
  });
}

/** The semantic-memory surface the UI server consumes (status + search). */
export interface MemoryProvider {
  status(): Promise<RagStatus>;
  search(query: string, k: number): Promise<readonly RagHit[]>;
}

/**
 * Build the daemon's semantic-memory provider from config + vault + store. `status` never
 * throws (degrades to unavailable when no embedder is configured); `search` runs the
 * `ragSearch` seam (throws `rag_unavailable` when disabled — the UI route catches it).
 * No reachability probe on the hot path: status reports `configured`, and a real search
 * surfaces an unreachable provider as an error to the caller.
 */
export async function makeMemoryProvider(
  config: VesperConfig,
  vault: Vault,
  store: Store,
): Promise<MemoryProvider> {
  const embedder = await makeEmbedder(config, vault, RAG_CAPABILITIES);
  const index = openRagIndex(store, embedder, RAG_CAPABILITIES);
  const resolved = resolveEmbeddings(config);
  return {
    status: async () =>
      ragStatus({
        configured: index !== null,
        indexedDocuments: store.ragDocumentCount(),
        ...(resolved !== null
          ? { provider: resolved.provider, model: resolved.model, dimensions: resolved.dimensions }
          : {}),
      }),
    search: (query, k) => ragSearch(index, query, k),
  };
}
