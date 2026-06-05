/**
 * Audit helper for connection mutations. Every connection state transition is
 * recorded on the existing `events` table (source `"connections"`) — NO migration.
 * This wrapper is the single choke point that strips any secret-bearing field
 * (the token value, a raw inbound/outbound message body) BEFORE it reaches the
 * store, so an audit row can never leak a credential or a message (the spec's
 * "Secret containment" SHALL + the memory protocol's never-write-secrets rule).
 */

import type { Store } from "../storage/index.ts";

/** The connection mutation kinds recorded to the audit log. */
export type ConnectionEventKind =
  | "connection_connected"
  | "connection_disconnected"
  | "connection_send_failed"
  | "connection_pairing_started"
  | "connection_paired"
  | "connection_pairing_failed"
  | "notification_sent"
  | "notification_failed"
  | "mcp_enabled"
  | "mcp_disabled";

/**
 * Field names that may carry a secret or a raw message body. They are removed
 * from any audit payload — only NON-secret wiring (ids, vault KEY NAMES, outcome)
 * is allowed through. The vault KEY name (`vaultKey`) is explicitly safe; the
 * VALUE (`token`, `value`, `secret`) is not.
 */
const REDACTED_KEYS: ReadonlySet<string> = new Set([
  "token",
  "value",
  "secret",
  "password",
  "text",
  "message",
  "body",
  "nonce",
  "qr",
]);

/** Drop any secret/message-body field from an audit payload (shallow). */
export function stripSensitive(
  payload: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(payload)) {
    if (REDACTED_KEYS.has(key)) continue;
    out[key] = val;
  }
  return out;
}

/**
 * Append a `source: "connections"` audit event with all secret/message-body
 * fields stripped, returning the new event id.
 */
export function recordConnectionEvent(
  store: Store,
  kind: ConnectionEventKind,
  payload: Readonly<Record<string, unknown>>,
): string {
  return store.appendEvent({
    source: "connections",
    kind,
    payload: stripSensitive(payload),
  });
}
