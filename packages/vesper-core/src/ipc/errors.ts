import { VesperError } from "../errors.ts";

/** Why an IPC operation failed. */
export type IpcErrorReason = "bad_request" | "not_implemented" | "timeout" | "connection_failed";

/** Raised by IPC operations, discriminated by {@link IpcError.reason}. */
export class IpcError extends VesperError {
  readonly reason: IpcErrorReason;

  constructor(reason: IpcErrorReason, message: string, options?: ErrorOptions) {
    super("ipc", message, options);
    this.reason = reason;
  }
}
