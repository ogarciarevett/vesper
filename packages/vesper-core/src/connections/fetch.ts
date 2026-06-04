/**
 * The single network-egress seam for channel handlers. Every outbound HTTP call a
 * handler makes routes through {@link allowlistedFetch}; no handler may call the
 * global `fetch` directly (a test invariant). This is where the two hard
 * guarantees live: the call asserts `NETWORK_FETCH`, and it refuses any host the
 * channel descriptor did not declare in `allowedHosts` — so Vesper only ever
 * reaches the first-party hosts a catalog entry names, never an LLM provider
 * (Hard rule 12).
 *
 * The `fetch` implementation is injected so the test suite fetches to NOTHING.
 */

import { assertCapabilities, type Capability } from "../capabilities/index.ts";
import { ConnectionError } from "./errors.ts";

/** A minimal fetch shape — the subset handlers use. Injected for tests. */
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** Options for {@link allowlistedFetch}. */
export interface AllowlistedFetchOptions {
  /** The target URL. Its host MUST be in {@link allowedHosts}. */
  readonly url: string;
  /** Hosts this call is permitted to reach (the descriptor's `allowedHosts`). */
  readonly allowedHosts: readonly string[];
  /** Capabilities the handler was granted; MUST include `NETWORK_FETCH`. */
  readonly granted: readonly Capability[];
  /** The fetch implementation. Defaults to the global `fetch`; inject for tests. */
  readonly fetchFn?: FetchFn;
  /** Standard fetch init (method, headers, body). */
  readonly init?: RequestInit;
}

/** Parse `url` and return its lowercase hostname, or null when malformed. */
function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Assert `NETWORK_FETCH`, then fetch `url` ONLY if its host is in `allowedHosts`.
 *
 * Throws {@link import("../capabilities/index.ts").CapabilityError} ("denied")
 * before any network work if `NETWORK_FETCH` is not granted; throws
 * {@link ConnectionError}("host_not_allowed") — and makes NO request — when the
 * URL is malformed or its host is not allowlisted.
 */
export async function allowlistedFetch(options: AllowlistedFetchOptions): Promise<Response> {
  const { url, allowedHosts, granted, init } = options;
  // Capability gate first: deny before parsing/network if NETWORK_FETCH is absent.
  assertCapabilities(["NETWORK_FETCH"], granted);

  const host = hostnameOf(url);
  if (host === null) {
    throw new ConnectionError("host_not_allowed", `malformed URL refused: ${url}`);
  }
  const allowed = allowedHosts.some((h) => h.toLowerCase() === host);
  if (!allowed) {
    throw new ConnectionError(
      "host_not_allowed",
      `host "${host}" is not in the channel allowlist [${allowedHosts.join(", ")}]`,
    );
  }

  const doFetch = options.fetchFn ?? fetch;
  return doFetch(url, init);
}
