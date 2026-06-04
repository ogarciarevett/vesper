/** The reason an approval-token operation failed. */
export type ApprovalErrorReason = "not_found" | "expired" | "already_used";

/**
 * Thrown by the approval-token store when a token cannot be verified — it was
 * never minted, has expired, or was already consumed (single-use). Carries a
 * typed `reason` so a route can map it to the right HTTP status.
 */
export class ApprovalError extends Error {
  readonly reason: ApprovalErrorReason;

  constructor(reason: ApprovalErrorReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ApprovalError";
    this.reason = reason;
  }
}
