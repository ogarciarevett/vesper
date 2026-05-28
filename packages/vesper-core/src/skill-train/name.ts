import { SkillTrainError } from "./errors.ts";

/** A skill name must be a simple slug — no path separators, no `.`/`..` traversal. */
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

/**
 * Reject a skill name that is not a plain slug, BEFORE it is joined into any
 * filesystem path. This is the path-traversal boundary guard for the skill name
 * coming from run params (`skill=<name>`): a value like `../../etc` would
 * otherwise resolve outside the intended skills/state directory.
 *
 * Directory params (`skillsDir`/`stateDir`) are operator-provided and trusted;
 * the *name* is the untrusted component, so it is the one we constrain.
 */
export function assertSkillName(name: string): void {
  if (!SKILL_NAME_RE.test(name)) {
    throw new SkillTrainError(
      "invalid_skill",
      `invalid skill name "${name}" — must be a slug (letters, digits, "-", "_"), no path separators`,
    );
  }
}
