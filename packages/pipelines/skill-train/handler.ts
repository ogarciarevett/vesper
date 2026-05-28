/**
 * The `skill-train` pipeline — SkillOpt-style auto-improvement of a Vesper skill.
 *
 * It is the first multi-capability pipeline (`CLI_INVOKE`, `READ/WRITE_STORAGE`,
 * `FS_READ`, `FS_WRITE`) and the "Agent-OS moment": the runtime improves its own
 * playbook using the user's CLI, holding no provider keys. The target and
 * optimizer models both route through `ctx.complete` (Hard rule 12); per-role
 * adapter splits + the friendly `vesper skill train` entry point land with the
 * CLI surface. For now the pipeline reads its inputs from run params:
 *
 *   skill=<name> skillsDir=<dir> stateDir=<dir> [epochs=N] [batchsize=M] [dryRun=true]
 *
 * It loads the skill + its `tasks.json`, runs the training loop, persists the
 * best candidate + per-epoch history under `stateDir`, and records the run.
 * Writing back to the committed `.ai/skills/<name>/SKILL.md` is a user-acked
 * IMPROVE step owned by the CLI, never this handler.
 */

import {
  loadSkill,
  type RegisterTaskInput,
  SkillTrainError,
  SkillTrainStore,
  type TaskHandler,
  trainSkill,
} from "@vesper/core";

/** Allowlisted handler id referenced by the `skill-train` task. */
export const SKILL_TRAIN_HANDLER_ID = "skill-train";

const DEFAULT_EPOCHS = 2;
const DEFAULT_BATCH_SIZE = 4;

/** Read a non-empty string param, or undefined. */
function strParam(params: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Read a positive-integer param (params arrive as strings), falling back to
 * `fallback` when absent. Throws on a present-but-invalid value — run params are
 * untrusted input and must be validated at this boundary.
 */
function numParam(
  params: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
): number {
  const value = params[key];
  if (value === undefined) return fallback;
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new SkillTrainError("invalid_tasks", `param "${key}" must be a positive integer`);
  }
  return parsed;
}

/** Read a boolean-ish param (`true`/boolean true). */
function boolParam(params: Readonly<Record<string, unknown>>, key: string): boolean {
  return params[key] === true || params[key] === "true";
}

export const skillTrainHandler: TaskHandler = async (ctx) => {
  const name = strParam(ctx.params, "skill");
  const skillsDir = strParam(ctx.params, "skillsDir");
  const stateDir = strParam(ctx.params, "stateDir");
  if (name === undefined || skillsDir === undefined || stateDir === undefined) {
    throw new SkillTrainError(
      "invalid_tasks",
      "skill-train requires params: skill, skillsDir, stateDir",
    );
  }

  const epochs = numParam(ctx.params, "epochs", DEFAULT_EPOCHS);
  const batchSize = numParam(ctx.params, "batchsize", DEFAULT_BATCH_SIZE);
  const dryRun = boolParam(ctx.params, "dryRun");
  const cliLabel = strParam(ctx.params, "cli") ?? "default";

  const skill = await loadSkill(name, { skillsDir });
  const store = new SkillTrainStore(stateDir);

  const result = await trainSkill({
    skill,
    complete: (prompt, opts) => ctx.complete(prompt, opts),
    epochs,
    batchSize,
    targetCli: cliLabel,
    optimizerCli: cliLabel,
    now: () => new Date().toISOString(),
    ...(dryRun ? { dryRun: true } : {}),
    onEpoch: (entry) => store.appendHistory(name, entry),
  });

  if (result.accepted && !dryRun) {
    await store.writeBest(name, result.bestBody);
  }

  const delta = `${result.baselineScore.toFixed(3)} -> ${result.bestScore.toFixed(3)}`;
  const verb = dryRun ? "dry-run" : result.accepted ? "improved" : "no improvement";
  // Reaching here means the run completed: "ok" when it improved (or a dry-run
  // inspection finished); "no_change" when no candidate beat the baseline.
  // Thrown failures never reach recordRun.
  const status = !dryRun && !result.accepted ? "no_change" : "ok";
  ctx.recordRun({
    status,
    summary: `skill-train ${name}: ${verb} (${delta}) over ${epochs} epoch(s)`,
  });
};

/**
 * Manual task wiring for `skill-train`. Declares the broadest capability set of
 * any pipeline so far — the deliberate stress test of the capability model.
 */
export const skillTrainTaskInput: RegisterTaskInput = {
  id: "skill-train",
  kind: "manual",
  schedule_expr: "",
  handler_id: SKILL_TRAIN_HANDLER_ID,
  max_duration_ms: 600_000,
  required_capabilities: ["CLI_INVOKE", "READ_STORAGE", "WRITE_STORAGE", "FS_READ", "FS_WRITE"],
};
