/** Public types for the skill-train module (SkillOpt-style skill optimization). */

/** The scorer that grades a task response against its expected answer. */
export type ScorerName = "exact_match" | "contains" | "judge";

/** YAML frontmatter fields that MUST be preserved verbatim across optimization. */
export interface SkillFrontmatter {
  readonly name: string;
  readonly description: string;
}

/** One validation task from a skill's sibling `tasks.json`. */
export interface SkillTask {
  readonly id: string;
  readonly prompt: string;
  readonly expected: string;
  /** Scorer to grade this task. Defaults to `"contains"` when omitted. */
  readonly scorer?: ScorerName;
}

/**
 * A loaded, trainable skill.
 *
 * `body` is the FULL `SKILL.md` content (frontmatter + prose) — the optimizer
 * rewrites this whole string each epoch, constrained to keep `frontmatter`
 * `name`/`description` identical.
 */
export interface Skill {
  readonly name: string;
  readonly body: string;
  readonly frontmatter: SkillFrontmatter;
  readonly tasks: readonly SkillTask[];
}

/**
 * A scorer grades an actual response against the expected answer, returning a
 * score in [0, 1]. May be synchronous (string scorers) or async (LLM-as-judge).
 */
export type Scorer = (actual: string, expected: string) => number | Promise<number>;

/** Outcome of running one task through the target CLI and scoring it. */
export interface TrajectoryResult {
  readonly taskId: string;
  readonly prompt: string;
  readonly expected: string;
  readonly response: string;
  readonly scorer: ScorerName;
  /** Score in [0, 1]. */
  readonly score: number;
}

/** One appended line in `history.jsonl` — a single epoch's outcome. */
export interface HistoryEntry {
  readonly epoch: number;
  /** Mean validation score of the running best BEFORE this epoch. */
  readonly priorBestScore: number;
  /** Mean validation score of the optimizer's candidate. */
  readonly candidateScore: number;
  readonly accepted: boolean;
  /** Resolved target/optimizer adapter names + best-effort model identifiers. */
  readonly targetCli: string;
  readonly optimizerCli: string;
  /** ISO timestamp, stamped by the caller (core never reads the clock). */
  readonly ts: string;
}
