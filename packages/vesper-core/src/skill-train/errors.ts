import { VesperError } from "../errors.ts";

/** Discriminant reasons for {@link SkillTrainError}. */
export type SkillTrainErrorReason =
  | "skill_not_found"
  | "invalid_skill"
  | "no_tasks"
  | "invalid_tasks"
  | "parse_failed"
  | "no_candidate"
  | "io_error";

/**
 * Raised by the skill-train module, discriminated by {@link SkillTrainError.reason}.
 * Carries `code = "skill_train"` (from {@link VesperError}) so cross-subsystem
 * catch blocks can separate it from vault/cli/storage errors.
 */
export class SkillTrainError extends VesperError {
  readonly reason: SkillTrainErrorReason;

  constructor(reason: SkillTrainErrorReason, message: string, options?: ErrorOptions) {
    super("skill_train", message, options);
    this.reason = reason;
  }
}
