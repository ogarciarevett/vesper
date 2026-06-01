/**
 * The auto-evolve skill-name allowlist + charset validator — the single security
 * linchpin of the gated-additive acquisition path.
 *
 * A candidate skill name is produced by the reflection LLM (or an allowlist) and
 * is destined to become a discrete argument to `bunx skills add <name>` via the
 * `Bun.spawn` array form (no shell string). Even so, this guard rejects anything
 * that is not a plain slug — no spaces, no shell metacharacters, no path
 * traversal, no leading hyphen (which would look like a CLI flag). A failing name
 * is dropped with an audit note and never reaches a process invocation.
 */

/**
 * A plain skill slug: lowercase letters, digits, hyphens; 1..64 chars; no leading
 * hyphen. Lowercase-only on purpose — the reflection-prompt contract emits lowercase
 * slugs, so an uppercase name is off-contract and rejected (narrower accepted set).
 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Allowlisted `owner/` source prefixes. A name MAY carry exactly one of these
 * prefixes (a published, trusted skill source); the segment after the prefix must
 * itself be a plain slug. Nothing else may contain a slash.
 */
export const ALLOWED_SKILL_SOURCES: readonly string[] = ["vercel-labs", "anthropics"];

/**
 * Returns true iff `name` is a safe skill identifier to pass to `bunx skills add`.
 *
 * Accepts either a bare slug (`^[a-z0-9][a-z0-9-]{0,63}$`) or an allowlisted
 * `owner/slug` where `owner` is in {@link ALLOWED_SKILL_SOURCES} and `slug` is a
 * bare slug. Rejects everything else — including non-string input.
 */
export function isAllowedSkillName(name: unknown): boolean {
  if (typeof name !== "string") return false;

  const slashIndex = name.indexOf("/");
  if (slashIndex === -1) {
    return SLUG_RE.test(name);
  }

  // Exactly one slash, splitting an allowlisted owner from a bare-slug skill.
  if (name.indexOf("/", slashIndex + 1) !== -1) return false;
  const owner = name.slice(0, slashIndex);
  const slug = name.slice(slashIndex + 1);
  return ALLOWED_SKILL_SOURCES.includes(owner) && SLUG_RE.test(slug);
}
