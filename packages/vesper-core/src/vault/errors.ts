import { VesperError } from "../errors.ts";

/** Why a vault operation failed. */
export type VaultErrorReason = "not_found" | "permission_denied" | "keychain_unavailable";

/** Raised by every {@link Vault} operation, discriminated by {@link VaultError.reason}. */
export class VaultError extends VesperError {
  readonly reason: VaultErrorReason;

  constructor(reason: VaultErrorReason, message: string, options?: ErrorOptions) {
    super("vault", message, options);
    this.reason = reason;
  }
}
