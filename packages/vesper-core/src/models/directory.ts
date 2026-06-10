/**
 * Live model directory (Omar 2026-06-10): an up-to-date list of the models the
 * user's CLIs can actually run, fetched from OpenRouter's PUBLIC catalog
 * (`/api/v1/models`, no API key — the same source the Vercel AI SDK ecosystem
 * reads). This is METADATA retrieval, not LLM access: the egress goes through
 * {@link allowlistedFetch} pinned to exactly one host, fail-soft, and the brain
 * stays the CLI (Hard rule 12 intact — same carve-out shape as benchmark-ingest
 * and the RAG embedder).
 *
 * Only models a CLI adapter can serve are kept: anthropic -> claude,
 * openai -> codex, google (gemini-*) -> gemini. Each row carries the exact
 * `flag` value to hand the adapter (anthropic slugs translate dots to dashes:
 * OpenRouter says "claude-opus-4.8", the claude CLI wants "claude-opus-4-8").
 */

import type { Capability } from "../capabilities/index.ts";
import { allowlistedFetch, type FetchFn } from "../connections/fetch.ts";

export const MODEL_DIRECTORY_URL = "https://openrouter.ai/api/v1/models";
export const MODEL_DIRECTORY_ALLOWED_HOSTS: readonly string[] = ["openrouter.ai"];

/** Providers Vesper can serve through an installed CLI adapter. */
export type DirectoryProvider = "anthropic" | "openai" | "google";

/** One runnable model from the live directory. */
export interface DirectoryModel {
  /** The exact value for the serving CLI's model flag (e.g. "claude-opus-4-8"). */
  readonly flag: string;
  readonly provider: DirectoryProvider;
  /** CLI adapter that serves this provider (claude | codex | gemini). */
  readonly cli: string;
  /** Human display name without the provider prefix (e.g. "Claude Opus 4.8"). */
  readonly name: string;
  readonly contextLength?: number;
  /** Unix seconds the model was listed (used for newest-first ordering). */
  readonly created?: number;
}

const PROVIDER_CLI: Readonly<Record<DirectoryProvider, string>> = {
  anthropic: "claude",
  openai: "codex",
  google: "gemini",
};

/** Strip the "Provider: " prefix OpenRouter puts on display names. */
function displayName(raw: string): string {
  return raw.replace(/^[^:]+:\s*/, "").trim();
}

/**
 * Map one raw catalog row to a runnable model, or null when no CLI serves it.
 * Variant suffixes (":free", ":beta") and non-text or non-chat families
 * (gemma, lyria, image models) are dropped — the CLIs cannot run them.
 */
function toDirectoryModel(raw: Record<string, unknown>): DirectoryModel | null {
  const id = typeof raw.id === "string" ? raw.id : "";
  const slash = id.indexOf("/");
  if (slash <= 0 || id.includes(":")) return null;
  const provider = id.slice(0, slash);
  const slug = id.slice(slash + 1);

  let entry: { provider: DirectoryProvider; flag: string } | null = null;
  if (provider === "anthropic" && slug.startsWith("claude-")) {
    entry = { provider: "anthropic", flag: slug.replaceAll(".", "-") };
  } else if (provider === "openai" && slug.startsWith("gpt-") && !slug.includes("image")) {
    entry = { provider: "openai", flag: slug };
  } else if (provider === "google" && slug.startsWith("gemini-")) {
    entry = { provider: "google", flag: slug };
  }
  if (entry === null) return null;

  const name = typeof raw.name === "string" ? displayName(raw.name) : entry.flag;
  const contextLength = typeof raw.context_length === "number" ? raw.context_length : undefined;
  const created = typeof raw.created === "number" ? raw.created : undefined;
  return {
    flag: entry.flag,
    provider: entry.provider,
    cli: PROVIDER_CLI[entry.provider],
    name,
    ...(contextLength !== undefined ? { contextLength } : {}),
    ...(created !== undefined ? { created } : {}),
  };
}

/** Parse the OpenRouter catalog body into runnable models, newest first. */
export function parseModelDirectory(body: unknown): DirectoryModel[] {
  if (typeof body !== "object" || body === null) return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const models: DirectoryModel[] = [];
  const seen = new Set<string>();
  for (const raw of data) {
    if (typeof raw !== "object" || raw === null) continue;
    const model = toDirectoryModel(raw as Record<string, unknown>);
    if (model === null || seen.has(model.flag)) continue;
    seen.add(model.flag);
    models.push(model);
  }
  return models.sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
}

export interface FetchModelDirectoryOptions {
  readonly granted: readonly Capability[];
  /** Injected for tests; production omits it for the real fetch. */
  readonly fetchFn?: FetchFn;
}

/**
 * Fetch and parse the live directory. Network or HTTP failures throw (the
 * caller decides how to degrade); an unexpected body shape parses to `[]`.
 */
export async function fetchModelDirectory(
  options: FetchModelDirectoryOptions,
): Promise<DirectoryModel[]> {
  const response = await allowlistedFetch({
    url: MODEL_DIRECTORY_URL,
    allowedHosts: MODEL_DIRECTORY_ALLOWED_HOSTS,
    granted: options.granted,
    ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
  });
  if (!response.ok) {
    throw new Error(`model directory fetch failed (HTTP ${response.status})`);
  }
  return parseModelDirectory(await response.json());
}
