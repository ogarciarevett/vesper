import type { CompleteFn } from "../scheduler/types.ts";
import { SkillTrainError } from "./errors.ts";
import { buildOptimizerPrompt, parseCandidate } from "./optimizer.ts";
import { resolveScorer } from "./scorers.ts";
import type { HistoryEntry, Scorer, Skill, SkillTask, TrajectoryResult } from "./types.ts";

/** Separator placed between the prepended SKILL.md and the task prompt. */
const SKILL_PROMPT_SEPARATOR = "\n\n---\n\n";

/** Options for {@link trainSkill}. All clocks/resolvers are injected (no ambient state). */
export interface TrainOptions {
  readonly skill: Skill;
  /** Target model resolver — runs each task's prompt. */
  readonly complete: CompleteFn;
  /** Optimizer model resolver. Defaults to {@link TrainOptions.complete}. */
  readonly optimizerComplete?: CompleteFn;
  /** Judge scorer for tasks whose `scorer` is `"judge"`. Required iff any task uses it. */
  readonly judge?: Scorer;
  /** Number of optimization epochs (>= 1). */
  readonly epochs: number;
  /** Tasks sampled per epoch for the optimizer batch (>= 1). */
  readonly batchSize: number;
  /** Resolved target/optimizer adapter names, recorded in history. */
  readonly targetCli: string;
  readonly optimizerCli: string;
  /** Injected ISO-timestamp source (core never reads the clock directly). */
  readonly now: () => string;
  /** When true, never adopt a candidate — propose and score only. */
  readonly dryRun?: boolean;
  /**
   * Fraction of tasks (0..1, exclusive) reserved as a held-out VALIDATION set.
   * When set, optimizer batches are sampled only from the remaining training
   * tasks and candidates are scored only on the held-out set — cutting the
   * per-epoch validation cost and removing train/val overlap. When omitted (or
   * out of range, or fewer than 2 tasks), both train and val are the full set
   * (the original behavior).
   */
  readonly valFraction?: number;
  /** Per-epoch hook (e.g. persistence/logging). Awaited if it returns a promise. */
  readonly onEpoch?: (
    entry: HistoryEntry,
    trajectories: readonly TrajectoryResult[],
  ) => void | Promise<void>;
}

/**
 * Deterministically split tasks into a held-out validation set and a training
 * set. With no/invalid `valFraction` or fewer than 2 tasks, both sets are the
 * full list (no split). The first `round(N * valFraction)` tasks (clamped to
 * leave at least one training task) become validation; the rest are training.
 */
export function splitTasks(
  tasks: readonly SkillTask[],
  valFraction?: number,
): { trainTasks: readonly SkillTask[]; valTasks: readonly SkillTask[] } {
  if (valFraction === undefined || valFraction <= 0 || valFraction >= 1 || tasks.length < 2) {
    return { trainTasks: tasks, valTasks: tasks };
  }
  const valCount = Math.min(tasks.length - 1, Math.max(1, Math.round(tasks.length * valFraction)));
  return { valTasks: tasks.slice(0, valCount), trainTasks: tasks.slice(valCount) };
}

/** Outcome of a full training run. */
export interface TrainResult {
  /** Final best SKILL.md (unchanged from the input when nothing was accepted). */
  readonly bestBody: string;
  /** Mean validation score of the original skill. */
  readonly baselineScore: number;
  /** Mean validation score of the final best. */
  readonly bestScore: number;
  /** True when at least one candidate was accepted. */
  readonly accepted: boolean;
  readonly history: readonly HistoryEntry[];
}

/** Compose the full prompt sent to the target: the skill body, then the task. */
function composePrompt(skillBody: string, task: SkillTask): string {
  return `${skillBody}${SKILL_PROMPT_SEPARATOR}${task.prompt}`;
}

/** Deterministic rotating batch: epoch N takes the next `batchSize` tasks, wrapping. */
function sampleBatch(tasks: readonly SkillTask[], epoch: number, batchSize: number): SkillTask[] {
  const size = Math.min(batchSize, tasks.length);
  const start = ((epoch - 1) * size) % tasks.length;
  const batch: SkillTask[] = [];
  for (let i = 0; i < size; i++) {
    const task = tasks[(start + i) % tasks.length];
    if (task !== undefined) batch.push(task);
  }
  return batch;
}

const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Run one task through the target model with the given skill body and score it.
 */
async function runTrajectory(
  skillBody: string,
  task: SkillTask,
  complete: CompleteFn,
  judge: Scorer | undefined,
): Promise<TrajectoryResult> {
  const scorerName = task.scorer ?? "contains";
  const scorer = resolveScorer(scorerName, judge !== undefined ? { judge } : {});
  const result = await complete(composePrompt(skillBody, task));
  const response = result.text;
  const score = await scorer(response, task.expected);
  return {
    taskId: task.id,
    prompt: task.prompt,
    expected: task.expected,
    response,
    scorer: scorerName,
    score,
  };
}

/** Evaluate a skill body across ALL tasks (the validation set); return mean score. */
async function evaluate(
  skillBody: string,
  tasks: readonly SkillTask[],
  complete: CompleteFn,
  judge: Scorer | undefined,
): Promise<{ score: number; trajectories: TrajectoryResult[] }> {
  const trajectories: TrajectoryResult[] = [];
  for (const task of tasks) {
    trajectories.push(await runTrajectory(skillBody, task, complete, judge));
  }
  return { score: mean(trajectories.map((t) => t.score)), trajectories };
}

/**
 * Train a skill via SkillOpt-style trajectory-driven optimization.
 *
 * Each epoch: sample a batch, run it through the target model, ask the optimizer
 * to rewrite the whole SKILL.md, then validate the candidate against ALL tasks.
 * Accept (greedy, val-strict) iff the candidate's mean score is strictly higher
 * than the current best — ties broken by fewer characters (shorter wins). Every
 * LLM call routes through an injected {@link CompleteFn} (Hard rule 12).
 *
 * Pure with respect to the filesystem and the clock: persistence happens via the
 * `onEpoch` hook, timestamps via the injected `now`.
 */
export async function trainSkill(options: TrainOptions): Promise<TrainResult> {
  const { skill, complete, epochs, batchSize, targetCli, optimizerCli, now } = options;
  if (epochs < 1) throw new SkillTrainError("invalid_skill", "epochs must be >= 1");
  if (batchSize < 1) throw new SkillTrainError("invalid_skill", "batchSize must be >= 1");

  const optimizerComplete = options.optimizerComplete ?? complete;
  const judge = options.judge;
  const dryRun = options.dryRun ?? false;
  const { trainTasks, valTasks } = splitTasks(skill.tasks, options.valFraction);

  const baseline = await evaluate(skill.body, valTasks, complete, judge);
  let bestBody = skill.body;
  let bestScore = baseline.score;
  let acceptedAny = false;
  const history: HistoryEntry[] = [];

  for (let epoch = 1; epoch <= epochs; epoch++) {
    const batch = sampleBatch(trainTasks, epoch, batchSize);
    const batchResults: TrajectoryResult[] = [];
    for (const task of batch) {
      batchResults.push(await runTrajectory(bestBody, task, complete, judge));
    }

    const prompt = buildOptimizerPrompt({
      skillBody: bestBody,
      results: batchResults,
      meanScore: mean(batchResults.map((r) => r.score)),
    });

    const priorBestScore = bestScore;
    let candidateScore = bestScore;
    let accepted = false;
    let candidateBody: string | undefined;
    try {
      const proposal = await optimizerComplete(prompt);
      candidateBody = parseCandidate(proposal.text, skill.frontmatter);
      const evaluated = await evaluate(candidateBody, valTasks, complete, judge);
      candidateScore = evaluated.score;
      accepted =
        candidateScore > bestScore ||
        (candidateScore === bestScore && candidateBody.length < bestBody.length);
    } catch (error) {
      // Only an unparseable/invalid optimizer candidate is a non-fatal skipped
      // epoch. Any other error (e.g. a judge misconfiguration surfacing mid-run)
      // must propagate so the run fails loudly rather than silently reporting
      // "no improvement".
      if (!(error instanceof SkillTrainError) || error.reason !== "parse_failed") throw error;
      accepted = false;
    }

    if (accepted && !dryRun && candidateBody !== undefined) {
      bestBody = candidateBody;
      bestScore = candidateScore;
      acceptedAny = true;
    }

    const entry: HistoryEntry = {
      epoch,
      priorBestScore,
      candidateScore,
      accepted: accepted && !dryRun,
      targetCli,
      optimizerCli,
      ts: now(),
    };
    history.push(entry);
    await options.onEpoch?.(entry, batchResults);
  }

  return { bestBody, baselineScore: baseline.score, bestScore, accepted: acceptedAny, history };
}
