import { VesperError } from "../errors.ts";

/** Why a capability check failed. */
export type CapabilityErrorReason = "denied";

/**
 * Raised when a task requests a capability that the host has not granted.
 *
 * `code` is "capability"; `reason` is always "denied".
 * The `message` lists the offending capability names.
 */
export class CapabilityError extends VesperError {
  readonly reason: CapabilityErrorReason;

  constructor(reason: CapabilityErrorReason, message: string, options?: ErrorOptions) {
    super("capability", message, options);
    this.reason = reason;
  }
}
