import { join } from "node:path";
import { SkillTrainError } from "./errors.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { assertSkillName } from "./name.ts";
import type { ScorerName, Skill, SkillTask } from "./types.ts";

/** Options controlling where and how a skill is loaded. */
export interface LoadSkillOptions {
  /** Directory holding <name>/SKILL.md and <name>/tasks.json (e.g. ".ai/skills"). */
  readonly skillsDir: string;
  /** Injectable file reader; defaults to reading via Bun.file(path).text(). */
  readonly readFile?: (path: string) => Promise<string>;
  /** Injectable existence check; defaults to Bun.file(path).exists(). */
  readonly exists?: (path: string) => Promise<boolean>;
}

/** Scorer names accepted in a skill's `tasks.json`. */
const VALID_SCORERS: readonly ScorerName[] = ["exact_match", "contains", "judge"];

/** Default file reader — reads UTF-8 text through Bun's file API. */
function defaultReadFile(path: string): Promise<string> {
  return Bun.file(path).text();
}

/** Default existence check — delegates to Bun's file API. */
function defaultExists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

/** Narrow an unknown JSON value to a plain object (record) without using `any`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Type guard for the optional `scorer` field. */
function isScorerName(value: unknown): value is ScorerName {
  return typeof value === "string" && (VALID_SCORERS as readonly string[]).includes(value);
}

/**
 * Validate one parsed JSON entry into a {@link SkillTask}.
 *
 * Throws {@link SkillTrainError} (`invalid_tasks`) describing which item failed
 * and why. `scorer` is set on the returned object ONLY when present, so the
 * shape stays compatible with `exactOptionalPropertyTypes`.
 */
function toSkillTask(entry: unknown, index: number): SkillTask {
  if (!isRecord(entry)) {
    throw new SkillTrainError("invalid_tasks", `task at index ${index} is not an object`);
  }
  if (typeof entry.id !== "string") {
    throw new SkillTrainError("invalid_tasks", `task at index ${index} is missing a string \`id\``);
  }
  if (typeof entry.prompt !== "string") {
    throw new SkillTrainError("invalid_tasks", `task ${entry.id} is missing a string \`prompt\``);
  }
  if (typeof entry.expected !== "string") {
    throw new SkillTrainError("invalid_tasks", `task ${entry.id} is missing a string \`expected\``);
  }
  if (entry.scorer !== undefined && !isScorerName(entry.scorer)) {
    throw new SkillTrainError(
      "invalid_tasks",
      `task ${entry.id} has an unknown scorer (expected one of ${VALID_SCORERS.join(", ")})`,
    );
  }
  const base = { id: entry.id, prompt: entry.prompt, expected: entry.expected };
  return entry.scorer === undefined ? base : { ...base, scorer: entry.scorer };
}

/** Parse + validate the tasks array, throwing typed errors for any violation. */
function parseTasks(raw: string, name: string): readonly SkillTask[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new SkillTrainError("invalid_tasks", `${name} tasks.json is not valid JSON`, { cause });
  }
  if (!Array.isArray(parsed)) {
    throw new SkillTrainError("invalid_tasks", `${name} tasks.json must be a JSON array`);
  }
  if (parsed.length === 0) {
    throw new SkillTrainError("no_tasks", `${name} tasks.json is empty — no validation tasks`);
  }
  return parsed.map((entry, index) => toSkillTask(entry, index));
}

/**
 * Load and validate a trainable skill.
 *
 * Reads `<skillsDir>/<name>/SKILL.md` (its full content is the optimizer's
 * `body`), parses the YAML frontmatter, and loads the sibling `tasks.json`
 * validation harness. File access is injectable for testing; production
 * defaults route through `Bun.file`.
 *
 * Throws {@link SkillTrainError} with a discriminating `reason`:
 * `skill_not_found` (no SKILL.md), `invalid_skill` (bad frontmatter — propagated
 * from {@link parseFrontmatter}), `no_tasks` (missing or empty tasks.json), or
 * `invalid_tasks` (malformed tasks).
 */
export async function loadSkill(name: string, options: LoadSkillOptions): Promise<Skill> {
  assertSkillName(name);
  const readFile = options.readFile ?? defaultReadFile;
  const exists = options.exists ?? defaultExists;

  const skillPath = join(options.skillsDir, name, "SKILL.md");
  if (!(await exists(skillPath))) {
    throw new SkillTrainError("skill_not_found", `no SKILL.md found for skill \`${name}\``);
  }
  const body = await readFile(skillPath);
  const frontmatter = parseFrontmatter(body);

  const tasksPath = join(options.skillsDir, name, "tasks.json");
  if (!(await exists(tasksPath))) {
    throw new SkillTrainError("no_tasks", `${name} has no tasks.json validation harness`);
  }
  const tasks = parseTasks(await readFile(tasksPath), name);

  return { name, body, frontmatter, tasks };
}
