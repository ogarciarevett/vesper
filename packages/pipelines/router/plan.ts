/**
 * Orchestration-plan authoring + FAIL-CLOSED validation (slice F).
 *
 * The model authors a staged plan as fenced JSON: `steps[]` run SEQUENTIALLY,
 * the `tasks[]` within a step run in PARALLEL, and between steps the lead
 * re-authors the next step's prompts WITH the prior outcomes (result piping).
 * `mode` is a closed enum (v1: "parallel") so nested/dependency modes extend
 * the same shape without re-platforming.
 *
 * Validation is the safety boundary: a task naming a pipeline outside the
 * contract map is DROPPED (handler ids never come from model text), params are
 * filtered to the contract's `paramKeys`, per-pipeline instances are clamped to
 * `maxInstances`, and the total is capped. Zero surviving tasks -> null
 * (the router falls back to a clarify turn).
 */

import type { OrchestrationContract } from "./contracts.ts";

/** Hard cap on tasks across the whole plan. */
export const ORCHESTRATION_MAX_TASKS = 4;
/** Hard cap on sequential steps. */
export const ORCHESTRATION_MAX_STEPS = 3;

/** Per-task difficulty the planner estimates; drives benchmark model selection. */
export type PlanDifficulty = "easy" | "medium" | "hard";

/** One validated plan task. */
export interface PlanTask {
  readonly pipeline: string;
  readonly label: string;
  /** The Vesper-authored prompt delivered via the contract's `promptParam`. */
  readonly prompt: string;
  /** Canonical catalog id, or null to let the selector pick by difficulty. */
  readonly model: string | null;
  readonly difficulty: PlanDifficulty;
  /** Extra params, already filtered to the contract's `paramKeys`. */
  readonly params: Readonly<Record<string, string>>;
}

/** One sequential step (tasks within run in parallel). */
export interface PlanStep {
  readonly mode: "parallel";
  readonly tasks: readonly PlanTask[];
}

/** A validated orchestration plan. */
export interface OrchestrationPlan {
  readonly steps: readonly PlanStep[];
  readonly notes: string;
}

/** Match the inner content of the FIRST fenced code block (optional language tag). */
const FENCE_RE = /```[^\n`]*\r?\n([\s\S]*?)\r?\n```/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asTrimmedString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

/** Build the plan-authoring prompt from the wish + the contract map. */
export function buildPlanPrompt(
  message: string,
  contracts: Readonly<Record<string, OrchestrationContract>>,
): string {
  const catalog = Object.values(contracts)
    .map(
      (c) =>
        `- ${c.handlerId}: ${c.summary} (max ${c.maxInstances} parallel` +
        `${c.paramKeys.length > 0 ? `; params: ${c.paramKeys.join(", ")}` : ""})`,
    )
    .join("\n");

  return [
    "You are Vesper, orchestrating a user's wish across your pipelines. YOU author",
    "every sub-agent's prompt — the user never prompts sub-agents directly.",
    "",
    "Available pipelines (the ONLY ids you may use):",
    catalog,
    "",
    "Decide which pipeline(s) to run, how many instances each (within its max),",
    "what each instance should focus on, and how hard each sub-task is.",
    "Steps run IN ORDER; tasks inside a step run in parallel. Use multiple steps",
    "only when a later task needs the earlier results.",
    "",
    "Reply with ONLY a fenced JSON block of this exact shape:",
    "```json",
    JSON.stringify(
      {
        steps: [
          {
            mode: "parallel",
            tasks: [
              {
                pipeline: "<id from the list>",
                label: "<short label>",
                prompt: "<the full prompt YOU author for this sub-agent>",
                model: null,
                difficulty: "easy | medium | hard",
                params: {},
              },
            ],
          },
        ],
        notes: "<one-line rationale>",
      },
      null,
      1,
    ),
    "```",
    `Hard limits: at most ${ORCHESTRATION_MAX_TASKS} tasks total, ${ORCHESTRATION_MAX_STEPS} steps.`,
    "",
    "User wish:",
    "<<<",
    message,
    ">>>",
  ].join("\n");
}

/**
 * Build the between-steps revision prompt: next-step prompts are re-authored
 * WITH the prior step's outcomes (result piping). Reply: fenced JSON
 * `[{ "label": "...", "prompt": "..." }]` for the next step's tasks.
 */
export function buildStepRevisionPrompt(
  message: string,
  nextTasks: readonly PlanTask[],
  priorOutcomes: readonly { label: string; status: string; summary: string }[],
): string {
  return [
    "You are Vesper, mid-orchestration. The previous step finished; re-author the",
    "next step's sub-agent prompts so they BUILD ON the results below.",
    "",
    "Previous step results:",
    ...priorOutcomes.map((o) => `- [${o.status}] ${o.label}: ${o.summary.slice(0, 400)}`),
    "",
    "Next step tasks (keep the same labels; rewrite only the prompts):",
    ...nextTasks.map((t) => `- ${t.label} (${t.pipeline}): ${t.prompt.slice(0, 400)}`),
    "",
    'Reply with ONLY a fenced JSON array: [{ "label": "...", "prompt": "..." }, ...]',
    "",
    "Original user wish:",
    "<<<",
    message,
    ">>>",
  ].join("\n");
}

/** Parse the step-revision reply; returns label->prompt or null (keep originals). */
export function parseStepRevision(text: string): Readonly<Record<string, string>> | null {
  const fenced = FENCE_RE.exec(text);
  const candidate = fenced?.[1]?.trim() ?? text.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: Record<string, string> = {};
  for (const item of parsed) {
    if (!isRecord(item)) continue;
    const label = asTrimmedString(item.label);
    const prompt = asTrimmedString(item.prompt);
    if (label !== undefined && prompt !== undefined) out[label] = prompt;
  }
  return Object.keys(out).length > 0 ? out : null;
}

const DIFFICULTIES: ReadonlySet<PlanDifficulty> = new Set(["easy", "medium", "hard"]);

/** Validate one raw task against its contract; undefined drops it. */
function parseTask(
  raw: unknown,
  contracts: Readonly<Record<string, OrchestrationContract>>,
): PlanTask | undefined {
  if (!isRecord(raw)) return undefined;
  const pipeline = asTrimmedString(raw.pipeline);
  // The safety boundary: only a contract key resolves; free-form ids are dropped.
  if (pipeline === undefined || !Object.hasOwn(contracts, pipeline)) return undefined;
  const contract = contracts[pipeline] as OrchestrationContract;
  const prompt = asTrimmedString(raw.prompt);
  if (prompt === undefined) return undefined;
  const label = asTrimmedString(raw.label) ?? pipeline;
  const difficultyRaw = asTrimmedString(raw.difficulty)?.toLowerCase();
  const difficulty: PlanDifficulty = DIFFICULTIES.has(difficultyRaw as PlanDifficulty)
    ? (difficultyRaw as PlanDifficulty)
    : "medium";
  const model = asTrimmedString(raw.model) ?? null;

  // Filter params to the contract's declared keys (string values only).
  const params: Record<string, string> = {};
  if (isRecord(raw.params)) {
    for (const key of contract.paramKeys) {
      const value = raw.params[key];
      if (typeof value === "string" && value.length > 0) params[key] = value;
    }
  }
  return { pipeline, label: label.slice(0, 80), prompt, model, difficulty, params };
}

/**
 * Parse + validate the plan reply FAIL-CLOSED. Returns null when nothing
 * survives validation (the caller falls back to clarify).
 */
export function parseOrchestrationPlan(
  text: string,
  contracts: Readonly<Record<string, OrchestrationContract>>,
): OrchestrationPlan | null {
  const fenced = FENCE_RE.exec(text);
  if (fenced?.[1] === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced[1].trim());
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.steps)) return null;

  const steps: PlanStep[] = [];
  let total = 0;
  const instancesByPipeline = new Map<string, number>();

  for (const rawStep of parsed.steps.slice(0, ORCHESTRATION_MAX_STEPS)) {
    if (!isRecord(rawStep) || !Array.isArray(rawStep.tasks)) continue;
    const tasks: PlanTask[] = [];
    for (const rawTask of rawStep.tasks) {
      if (total >= ORCHESTRATION_MAX_TASKS) break;
      const task = parseTask(rawTask, contracts);
      if (task === undefined) continue;
      const contract = contracts[task.pipeline] as OrchestrationContract;
      const used = instancesByPipeline.get(task.pipeline) ?? 0;
      // The contract's ceiling is respected unconditionally.
      if (used >= contract.maxInstances) continue;
      instancesByPipeline.set(task.pipeline, used + 1);
      tasks.push(task);
      total += 1;
    }
    if (tasks.length > 0) steps.push({ mode: "parallel", tasks });
  }

  if (steps.length === 0) return null;
  const notes = asTrimmedString(parsed.notes) ?? "";
  return { steps, notes };
}
