/**
 * The bring-your-own embedding source for RAG (specs/rag-memory.md v2). Turns text into
 * vectors over HTTP against EITHER a local server (Ollama) or an OpenAI-compatible endpoint
 * the user holds a key for. There is NO provider SDK and NO new dependency: it uses the global
 * `fetch` through the shipped {@link allowlistedFetch} seam, so every call asserts
 * `NETWORK_FETCH` first and is refused unless the host is allowlisted (Hard rule 12: embeddings
 * are a retrieval utility reaching the user's own source, never an LLM brain).
 */

import type { Capability } from "../../capabilities/index.ts";
import { allowlistedFetch, type FetchFn } from "../../connections/fetch.ts";
import type { Embedder } from "../embedder.ts";

/** Response wire format. `ollama` -> /api/embed; `openai` -> /v1/embeddings (OpenAI / Voyage). */
export type EmbedderFormat = "ollama" | "openai";

export interface HttpEmbedderOptions {
  /** Stable id persisted per indexed row, e.g. "ollama:nomic-embed-text". */
  readonly id: string;
  readonly format: EmbedderFormat;
  /** Base URL, e.g. "http://localhost:11434" or "https://api.openai.com". */
  readonly endpoint: string;
  readonly model: string;
  /** Expected vector width; a response of another width is rejected. */
  readonly dimensions: number;
  /** Bearer key for the `openai` format (resolved from the vault by the host). */
  readonly apiKey?: string;
  /** Hosts this embedder may reach (just the provider's). */
  readonly allowedHosts: readonly string[];
  /** Capabilities the caller was granted; MUST include `NETWORK_FETCH`. */
  readonly granted: readonly Capability[];
  /** Injected for tests; defaults to the global fetch. */
  readonly fetchFn?: FetchFn;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    throw new Error("embedder: expected a numeric array in the response");
  }
  return value.map((n) => {
    if (typeof n !== "number" || !Number.isFinite(n)) {
      throw new Error("embedder: embedding contains a non-finite value");
    }
    return n;
  });
}

function parseOllama(body: unknown): number[][] {
  if (!isRecord(body) || !Array.isArray(body.embeddings)) {
    throw new Error("ollama embedder: response missing an `embeddings` array");
  }
  return body.embeddings.map(asNumberArray);
}

function parseOpenai(body: unknown): number[][] {
  if (!isRecord(body) || !Array.isArray(body.data)) {
    throw new Error("openai embedder: response missing a `data` array");
  }
  const items = body.data.map((item, i) => {
    if (!isRecord(item)) {
      throw new Error("openai embedder: a `data` item is not an object");
    }
    const index = typeof item.index === "number" ? item.index : i;
    return { index, embedding: asNumberArray(item.embedding) };
  });
  items.sort((a, b) => a.index - b.index);
  return items.map((it) => it.embedding);
}

function toVectors(raw: number[][], count: number, dims: number, id: string): Float32Array[] {
  if (raw.length !== count) {
    throw new Error(`embedder ${id}: expected ${count} vectors, got ${raw.length}`);
  }
  return raw.map((vec) => {
    if (vec.length !== dims) {
      throw new Error(`embedder ${id}: expected ${dims}-dim vector, got ${vec.length}`);
    }
    return Float32Array.from(vec);
  });
}

function buildRequest(
  opts: HttpEmbedderOptions,
  base: string,
  texts: readonly string[],
): {
  url: string;
  init: RequestInit;
} {
  const body = JSON.stringify({ model: opts.model, input: texts });
  if (opts.format === "ollama") {
    return {
      url: `${base}/api/embed`,
      init: { method: "POST", headers: { "content-type": "application/json" }, body },
    };
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.apiKey !== undefined && opts.apiKey !== "") {
    headers.authorization = `Bearer ${opts.apiKey}`;
  }
  return { url: `${base}/v1/embeddings`, init: { method: "POST", headers, body } };
}

/** Construct an {@link Embedder} backed by an HTTP embeddings endpoint. */
export function makeHttpEmbedder(opts: HttpEmbedderOptions): Embedder {
  const base = opts.endpoint.replace(/\/+$/, "");
  return {
    id: opts.id,
    dimensions: opts.dimensions,
    async embed(texts: readonly string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      const { url, init } = buildRequest(opts, base, texts);
      const res = await allowlistedFetch({
        url,
        allowedHosts: opts.allowedHosts,
        granted: opts.granted,
        init,
        ...(opts.fetchFn !== undefined ? { fetchFn: opts.fetchFn } : {}),
      });
      if (!res.ok) {
        throw new Error(`embedder ${opts.id}: HTTP ${res.status} from ${url}`);
      }
      const body: unknown = await res.json();
      const raw = opts.format === "ollama" ? parseOllama(body) : parseOpenai(body);
      return toVectors(raw, texts.length, opts.dimensions, opts.id);
    },
  };
}
