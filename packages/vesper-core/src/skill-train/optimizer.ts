import { SkillTrainError } from "./errors.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import type { SkillFrontmatter, TrajectoryResult } from "./types.ts";

/** Inputs to {@link buildOptimizerPrompt}. */
export interface OptimizerInput {
  /** Current full `SKILL.md` (frontmatter + prose). */
  readonly skillBody: string;
  /** Scored task results from the current epoch's batch. */
  readonly results: readonly TrajectoryResult[];
  /** Current mean validation score, for context. */
  readonly meanScore: number;
}

/** Render one task result as a labelled block for the meta-prompt. */
function renderResult(result: TrajectoryResult, index: number): string {
  return [
    `### Task ${index + 1} (id: ${result.taskId}, scorer: ${result.scorer}, score: ${result.score})`,
    "Prompt:",
    result.prompt,
    "Expected:",
    result.expected,
    "Model response:",
    result.response,
  ].join("\n");
}

/**
 * Build the deterministic meta-prompt that asks the optimizer LLM to rewrite the
 * whole `SKILL.md` so the batch scores higher, while preserving the YAML
 * frontmatter `name`/`description` byte-for-byte. Wording is fixed (no
 * randomness) so two identical inputs always yield the same prompt.
 */
export function buildOptimizerPrompt(input: OptimizerInput): string {
  const renderedResults = input.results
    .map((result, index) => ({ result, index }))
    .sort((a, b) => a.result.score - b.result.score)
    // Re-number by post-sort position so headers read in display order.
    .map(({ result }, position) => renderResult(result, position))
    .join("\n\n");

  return [
    "You are an expert prompt and agent-skill optimizer.",
    "",
    `The current SKILL.md has a mean validation score of ${input.meanScore.toFixed(3)}.`,
    "Your job is to rewrite the ENTIRE SKILL.md so it scores higher on the tasks below.",
    "",
    "## Current SKILL.md",
    "",
    input.skillBody,
    "",
    "## Task results (lowest-scoring first — these are the gaps to fix)",
    "",
    renderedResults,
    "",
    "## Instructions",
    "",
    "Rewrite the ENTIRE SKILL.md to score higher on the tasks above, focusing on the low-scoring ones.",
    "You MUST keep the YAML frontmatter `name:` and `description:` fields byte-for-byte identical to the current SKILL.md — do not change, rephrase, or reformat them.",
    "Output ONLY the new SKILL.md inside a single fenced code block (```markdown ... ```), with nothing before or after the fence.",
  ].join("\n");
}

/** Match the inner content of the FIRST fenced code block (optional language tag). */
const FENCE_RE = /```[^\n`]*\r?\n([\s\S]*?)\r?\n```/;

/** Extract the candidate SKILL.md text from the optimizer's raw response. */
function extractCandidate(optimizerText: string): string {
  const fenced = FENCE_RE.exec(optimizerText);
  if (fenced?.[1] !== undefined) {
    return fenced[1].trim();
  }
  return optimizerText.trim();
}

/**
 * Extract and validate the optimizer's candidate `SKILL.md`. Returns the new
 * full `SKILL.md` string.
 *
 * Throws {@link SkillTrainError} (`parse_failed`) when no valid candidate can be
 * extracted, or when its frontmatter `name`/`description` differ from
 * `requiredFrontmatter` (which MUST be preserved verbatim).
 */
export function parseCandidate(
  optimizerText: string,
  requiredFrontmatter: SkillFrontmatter,
): string {
  const candidate = extractCandidate(optimizerText);

  let frontmatter: SkillFrontmatter;
  try {
    frontmatter = parseFrontmatter(candidate);
  } catch (cause) {
    throw new SkillTrainError("parse_failed", "optimizer candidate has no valid frontmatter", {
      cause,
    });
  }

  if (
    frontmatter.name !== requiredFrontmatter.name ||
    frontmatter.description !== requiredFrontmatter.description
  ) {
    throw new SkillTrainError(
      "parse_failed",
      "optimizer changed the frontmatter name/description, which must be preserved",
    );
  }

  return candidate;
}
