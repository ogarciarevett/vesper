import { SkillTrainError } from "./errors.ts";
import type { SkillFrontmatter } from "./types.ts";

/** Strip one layer of matching single/double quotes from a scalar value. */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' || first === "'") && last === first) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/** Extract a single-line `key: value` scalar from a frontmatter block, or undefined. */
function field(block: string, key: string): string | undefined {
  const re = new RegExp(`^${key}:[ \\t]*(.+)$`, "m");
  const match = re.exec(block);
  if (match?.[1] === undefined) return undefined;
  const value = unquote(match[1]);
  return value.length > 0 ? value : undefined;
}

/**
 * Parse the YAML frontmatter of a `SKILL.md` and return its `name` and
 * `description`. Only these two single-line scalar fields are read — Vesper
 * skills never need richer YAML, and keeping the parser tiny avoids a dependency.
 *
 * Throws {@link SkillTrainError} (`invalid_skill`) when the leading
 * `---`-delimited block is absent or either field is missing/empty.
 */
export function parseFrontmatter(markdown: string): SkillFrontmatter {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (block?.[1] === undefined) {
    throw new SkillTrainError("invalid_skill", "SKILL.md is missing its YAML frontmatter block");
  }
  const name = field(block[1], "name");
  const description = field(block[1], "description");
  if (name === undefined || description === undefined) {
    throw new SkillTrainError(
      "invalid_skill",
      "SKILL.md frontmatter must define both `name` and `description`",
    );
  }
  return { name, description };
}
