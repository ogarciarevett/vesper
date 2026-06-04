/**
 * Out-of-band approval tokens for privileged, out-of-band mutations.
 *
 * The daemon mints a short, single-use code (CSPRNG) with a short TTL; a privileged
 * route (e.g. `PUT /api/pipelines/:id/template`) requires the caller to present a
 * valid, unexpired, unconsumed code. This is the minimal self-contained module the
 * future `security-hardening.md` adopts — it adds a SECOND factor over `isLocalRequest`
 * so a malicious local script cannot silently rewrite a pipeline's config without the
 * code the daemon surfaced to the operator out-of-band.
 *
 * The store is in-memory by design: tokens are ephemeral and per-daemon-process; a
 * restart invalidates every outstanding code (fail-closed). No token is ever persisted
 * or logged. `crypto.getRandomValues` is the CSPRNG seam; `() => Date.now()` is the
 * clock seam (injectable for deterministic tests).
 */

import { ApprovalError } from "./errors.ts";

/** Default time-to-live for a minted token (5 minutes). */
export const DEFAULT_TOKEN_TTL_MS = 5 * 60 * 1_000;

/** Number of random bytes behind a code; 12 bytes -> 24 lowercase hex chars. */
const TOKEN_BYTES = 12;

/** A live token entry: when it expires, and whether it was already consumed. */
interface TokenEntry {
  readonly expiresAt: number;
  used: boolean;
}

/** Options for {@link ApprovalTokenStore}. */
export interface ApprovalTokenStoreOptions {
  /** Token lifetime in ms. Defaults to {@link DEFAULT_TOKEN_TTL_MS}. Clamped to >= 1. */
  readonly ttlMs?: number;
  /** Clock seam (ms since epoch). Defaults to `Date.now`. Inject for tests. */
  readonly now?: () => number;
  /**
   * CSPRNG seam — fills the given buffer with random bytes. Defaults to
   * `crypto.getRandomValues`. Inject ONLY for tests; production must use a CSPRNG.
   */
  readonly randomBytes?: (out: Uint8Array) => void;
}

/** Lower-hex encode a byte buffer (no separators). */
function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) {
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * In-memory store of single-use, short-TTL approval codes.
 *
 * - `mint()` returns a fresh CSPRNG code and records its expiry.
 * - `verify(code)` consumes the code: it succeeds exactly once for a valid,
 *   unexpired code and throws {@link ApprovalError} otherwise (`not_found`,
 *   `expired`, `already_used`). Verifying marks the code used so a replay fails.
 */
export class ApprovalTokenStore {
  readonly #tokens = new Map<string, TokenEntry>();
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #randomBytes: (out: Uint8Array) => void;

  constructor(options: ApprovalTokenStoreOptions = {}) {
    this.#ttlMs = Math.max(1, options.ttlMs ?? DEFAULT_TOKEN_TTL_MS);
    this.#now = options.now ?? (() => Date.now());
    this.#randomBytes = options.randomBytes ?? ((out) => crypto.getRandomValues(out));
  }

  /** Mint a fresh single-use code and return it. The raw code is never persisted to disk. */
  mint(): string {
    const buf = new Uint8Array(TOKEN_BYTES);
    this.#randomBytes(buf);
    const code = toHex(buf);
    this.#tokens.set(code, { expiresAt: this.#now() + this.#ttlMs, used: false });
    return code;
  }

  /**
   * Consume `code`. Returns nothing on success (the code is now spent). Throws
   * {@link ApprovalError}:
   * - `not_found` when the code was never minted (or was purged after expiry);
   * - `expired` when the code is past its TTL (it is dropped);
   * - `already_used` when the code was previously verified (replay).
   */
  verify(code: string): void {
    const entry = this.#tokens.get(code);
    if (entry === undefined) {
      throw new ApprovalError("not_found", "approval code is not recognised");
    }
    if (this.#now() >= entry.expiresAt) {
      this.#tokens.delete(code);
      throw new ApprovalError("expired", "approval code has expired");
    }
    if (entry.used) {
      throw new ApprovalError("already_used", "approval code was already used");
    }
    entry.used = true;
  }

  /**
   * Non-consuming check used by routes that want a boolean. Returns true iff the
   * code is valid, unexpired, and unused — but does NOT mark it used. Prefer
   * {@link verify} on the mutation path so the code is single-use.
   */
  isValid(code: string): boolean {
    const entry = this.#tokens.get(code);
    if (entry === undefined) return false;
    if (this.#now() >= entry.expiresAt) return false;
    return !entry.used;
  }

  /** Drop expired/used entries so the map does not grow unbounded. */
  prune(): void {
    const now = this.#now();
    for (const [code, entry] of this.#tokens) {
      if (entry.used || now >= entry.expiresAt) {
        this.#tokens.delete(code);
      }
    }
  }
}
