import { VesperError } from "../errors.ts";

/** Discriminant reasons for {@link CLIError}. */
export type CLIErrorReason = "not_installed" | "not_authenticated" | "timeout" | "nonzero_exit";

/**
 * Raised by every {@link import("./types.ts").CLIAdapter} operation, discriminated by
 * {@link CLIError.reason}. Callers branch on `reason` rather than string-matching messages.
 *
 * Carries `code = "cli"` (inherited from {@link VesperError}) so cross-subsystem catch blocks
 * can separate CLI errors from vault errors, process errors, etc.
 */
export class CLIError extends VesperError {
  readonly reason: CLIErrorReason;

  constructor(reason: CLIErrorReason, message: string, options?: ErrorOptions) {
    super("cli", message, options);
    this.reason = reason;
  }
}
