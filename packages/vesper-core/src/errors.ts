/**
 * Base class for every Vesper error.
 *
 * Carries a stable, machine-readable `code` naming the subsystem that raised it
 * ("vault", "cli", "storage", "process", ...). Concrete errors extend this and
 * add their own typed `reason` where a finer discriminant is useful. Keeping a
 * single base means callers can branch on `code`/`reason` instead of string
 * matching, and `instanceof VesperError` reliably separates our errors from
 * unexpected ones.
 */
export class VesperError extends Error {
  /** Subsystem that raised the error, e.g. "vault". */
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    // `new.target` is the most-derived constructor, so subclasses report their
    // own name without each having to set it.
    this.name = new.target.name;
    this.code = code;
  }
}
