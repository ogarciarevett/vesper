/**
 * Capability tokens that a task may require and the host may grant.
 *
 * String literal union (not enum) per project convention.
 * Enforcement is performed by {@link assertCapabilities}.
 */

export type Capability =
  | "READ_VAULT"
  | "WRITE_VAULT"
  | "READ_STORAGE"
  | "WRITE_STORAGE"
  | "CLI_INVOKE"
  | "NETWORK_FETCH"
  | "FS_READ"
  | "FS_WRITE"
  | "SPAWN_SUBAGENT";

/** Exhaustive tuple of all {@link Capability} values. */
export const CAPABILITIES: readonly Capability[] = [
  "READ_VAULT",
  "WRITE_VAULT",
  "READ_STORAGE",
  "WRITE_STORAGE",
  "CLI_INVOKE",
  "NETWORK_FETCH",
  "FS_READ",
  "FS_WRITE",
  "SPAWN_SUBAGENT",
] as const;

/** Type-guard: returns true iff `x` is a known {@link Capability} value. */
export function isCapability(x: unknown): x is Capability {
  return typeof x === "string" && (CAPABILITIES as readonly string[]).includes(x);
}
