/** The reason a connection operation failed. */
export type ConnectionErrorReason =
  | "host_not_allowed"
  | "not_authenticated"
  | "not_installed"
  | "send_failed"
  | "receive_failed"
  | "unknown_channel"
  | "invalid_response";

/**
 * Thrown by the connections layer (the allowlisted-fetch seam and channel
 * handlers) when a network or transport operation is refused. Carries a typed
 * `reason` so a route or CLI command can map it to the right outcome.
 *
 * `host_not_allowed` is the load-bearing invariant: a handler may only egress to
 * a host its descriptor declares in `allowedHosts` — never an arbitrary host and
 * never an LLM provider (Hard rule 12).
 */
export class ConnectionError extends Error {
  readonly reason: ConnectionErrorReason;

  constructor(reason: ConnectionErrorReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ConnectionError";
    this.reason = reason;
  }
}
