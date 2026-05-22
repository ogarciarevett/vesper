import type { Capability } from "./capability.ts";
import { CapabilityError } from "./errors.ts";

/**
 * Returns true iff every capability in `requested` is present in `granted`.
 *
 * Deny-by-default: an empty `granted` list denies every non-empty `requested` list.
 */
export function isGranted(
  requested: readonly Capability[],
  granted: readonly Capability[],
): boolean {
  for (const cap of requested) {
    if (!granted.includes(cap)) {
      return false;
    }
  }
  return true;
}

/**
 * Assert that all `requested` capabilities are present in `granted`.
 *
 * Throws {@link CapabilityError} (reason "denied") listing the offending
 * capabilities if any requested capability is not granted.
 *
 * Deny-by-default: a task with `requested` capabilities that are not all in
 * `granted` is refused, regardless of how many caps are in `granted`.
 * A task with an empty `requested` list always passes (no capabilities needed).
 */
export function assertCapabilities(
  requested: readonly Capability[],
  granted: readonly Capability[],
): void {
  const denied = requested.filter((cap) => !granted.includes(cap));
  if (denied.length > 0) {
    throw new CapabilityError("denied", `capabilities denied: ${denied.join(", ")}`);
  }
}
