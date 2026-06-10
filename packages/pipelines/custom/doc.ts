/**
 * PipelineDoc v1 — the user-authored pipeline document (specs/pipeline-editor.md).
 *
 * This is USER input, so unlike the model-authored plan (drop-and-continue), parsing
 * reports every problem explicitly: `parsePipelineDoc` returns `{ok:false, errors}`
 * instead of silently clamping. Two step kinds only (the anti-n8n constraint):
 * `prompt` (markdown + optional skills + optional command prefix + per-step cli/model)
 * and `pipeline` (an ORCHESTRATION_CONTRACTS key — nothing else is invocable).
 * Capabilities are DERIVED from the doc, never user-picked.
 */

import type { Capability } from "@vesper/core";
import type { OrchestrationContract } from "../router/contracts.ts";

/** Hard ceilings (deliberately modest — a doc is a personal automation, not a DAG). */
export const MAX_STAGES = 5;
export const MAX_TASKS_PER_STAGE = 4;

/** A markdown prompt run through the user's CLI (with optional skills + command prefix). */
export interface PromptStep {
  readonly kind: "prompt";
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  /** SkillLibrary names whose bodies are prepended at run time. */
  readonly skills: readonly string[];
  /** Optional CLI command prefix (e.g. "/spec") prepended verbatim to the prompt. */
  readonly command?: string;
  /** CLI adapter override for this step (default: configured CLI). */
  readonly cli?: string;
  /** Canonical catalog model id for this step (default: adapter default). */
  readonly model?: string;
}

/** An invocation of an existing pipeline via its orchestration contract. */
export interface PipelineStep {
  readonly kind: "pipeline";
  readonly id: string;
  readonly title: string;
  /** An ORCHESTRATION_CONTRACTS key — validated, never free-form. */
  readonly target: string;
  /** Delivered in the contract's `promptParam`. */
  readonly prompt: string;
  /** Extra params; every key must be contract-declared (unknown keys are errors). */
  readonly params: Readonly<Record<string, string>>;
  readonly model?: string;
}

export type PipelineDocStep = PromptStep | PipelineStep;

/** One sequential stage; its tasks run in parallel. */
export interface PipelineDocStage {
  readonly tasks: readonly PipelineDocStep[];
}

/** The mastermind block: re-authors stage prompts with prior results when enabled. */
export interface PipelineDocOrchestrator {
  readonly enabled: boolean;
  /** Canonical catalog id; absent -> benchmark frontier pick / configured default. */
  readonly model?: string;
  /** Extra standing guidance injected into every orchestrator call. */
  readonly instructions?: string;
}

/** How steps share context. v1: result piping (+ optional RAG memory). */
export interface PipelineDocSharing {
  readonly mode: "piped";
  /** Prepend top-K semantic-memory hits to stage-1 prompts (requires READ_STORAGE). */
  readonly memory: boolean;
}

/** The validated document the editor saves and the interpreter runs. */
export interface PipelineDoc {
  readonly v: 1;
  readonly name: string;
  readonly description: string;
  readonly orchestrator: PipelineDocOrchestrator;
  readonly sharing: PipelineDocSharing;
  readonly stages: readonly PipelineDocStage[];
}

/** Fail-closed parse outcome: a valid doc, or every error found (never partial). */
export type ParsePipelineDocResult =
  | { readonly ok: true; readonly doc: PipelineDoc }
  | { readonly ok: false; readonly errors: readonly string[] };

/** Storage/task-id shape for a custom pipeline (`custom:<id>` must stay unambiguous). */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidCustomPipelineId(id: string): boolean {
  return ID_RE.test(id);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asTrimmedString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

/** Parse one raw step; pushes errors (prefixed with its position) instead of dropping. */
function parseStep(
  raw: unknown,
  position: string,
  contracts: Readonly<Record<string, OrchestrationContract>>,
  errors: string[],
): PipelineDocStep | undefined {
  if (!isRecord(raw)) {
    errors.push(`${position}: step must be an object`);
    return undefined;
  }
  const id = asTrimmedString(raw.id);
  if (id === undefined || !ID_RE.test(id)) {
    errors.push(`${position}: step id must match ${ID_RE.source}`);
    return undefined;
  }
  const title = asTrimmedString(raw.title) ?? id;
  const prompt = asTrimmedString(raw.prompt);
  if (prompt === undefined) {
    errors.push(`${position} (${id}): prompt must be a non-empty string`);
    return undefined;
  }
  const model = asTrimmedString(raw.model);

  if (raw.kind === "prompt") {
    const skills: string[] = [];
    if (raw.skills !== undefined) {
      if (!Array.isArray(raw.skills)) {
        errors.push(`${position} (${id}): skills must be an array of names`);
        return undefined;
      }
      for (const s of raw.skills) {
        const name = asTrimmedString(s);
        if (name === undefined) {
          errors.push(`${position} (${id}): skills must be non-empty strings`);
          return undefined;
        }
        skills.push(name);
      }
    }
    const command = asTrimmedString(raw.command);
    const cli = asTrimmedString(raw.cli);
    return {
      kind: "prompt",
      id,
      title,
      prompt,
      skills,
      ...(command !== undefined ? { command } : {}),
      ...(cli !== undefined ? { cli } : {}),
      ...(model !== undefined ? { model } : {}),
    };
  }

  if (raw.kind === "pipeline") {
    const target = asTrimmedString(raw.target);
    if (target === undefined || !Object.hasOwn(contracts, target)) {
      errors.push(
        `${position} (${id}): target "${target ?? ""}" is not an orchestratable pipeline`,
      );
      return undefined;
    }
    const contract = contracts[target] as OrchestrationContract;
    const params: Record<string, string> = {};
    if (raw.params !== undefined) {
      if (!isRecord(raw.params)) {
        errors.push(`${position} (${id}): params must be an object`);
        return undefined;
      }
      for (const [key, value] of Object.entries(raw.params)) {
        if (!contract.paramKeys.includes(key)) {
          errors.push(
            `${position} (${id}): param "${key}" is not declared by "${target}" ` +
              `(allowed: ${contract.paramKeys.join(", ") || "none"})`,
          );
          return undefined;
        }
        if (typeof value !== "string" || value.length === 0) {
          errors.push(`${position} (${id}): param "${key}" must be a non-empty string`);
          return undefined;
        }
        params[key] = value;
      }
    }
    return {
      kind: "pipeline",
      id,
      title,
      target,
      prompt,
      params,
      ...(model !== undefined ? { model } : {}),
    };
  }

  errors.push(`${position}: kind must be "prompt" or "pipeline"`);
  return undefined;
}

/**
 * Parse + validate a raw document FAIL-CLOSED: any error invalidates the whole doc
 * and every problem found is reported (the editor shows them all at once).
 */
export function parsePipelineDoc(
  value: unknown,
  contracts: Readonly<Record<string, OrchestrationContract>>,
): ParsePipelineDocResult {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ["document must be a JSON object"] };
  }
  if (value.v !== 1) errors.push('version: "v" must be 1');
  const name = asTrimmedString(value.name);
  if (name === undefined) errors.push("name: must be a non-empty string");
  const description = asTrimmedString(value.description) ?? "";

  // Orchestrator block (default: enabled, no model pin).
  let orchestrator: PipelineDocOrchestrator = { enabled: true };
  if (value.orchestrator !== undefined) {
    if (!isRecord(value.orchestrator)) {
      errors.push("orchestrator: must be an object");
    } else {
      const model = asTrimmedString(value.orchestrator.model);
      const instructions = asTrimmedString(value.orchestrator.instructions);
      orchestrator = {
        enabled: value.orchestrator.enabled !== false,
        ...(model !== undefined ? { model } : {}),
        ...(instructions !== undefined ? { instructions } : {}),
      };
    }
  }

  // Sharing block (default: piped, no memory).
  let sharing: PipelineDocSharing = { mode: "piped", memory: false };
  if (value.sharing !== undefined) {
    if (!isRecord(value.sharing)) {
      errors.push("sharing: must be an object");
    } else {
      if (value.sharing.mode !== undefined && value.sharing.mode !== "piped") {
        errors.push('sharing: mode must be "piped" (v1)');
      }
      sharing = { mode: "piped", memory: value.sharing.memory === true };
    }
  }

  const stages: PipelineDocStage[] = [];
  if (!Array.isArray(value.stages) || value.stages.length === 0) {
    errors.push("stages: must be a non-empty array");
  } else if (value.stages.length > MAX_STAGES) {
    errors.push(`stages: at most ${MAX_STAGES} stages`);
  } else {
    const seenIds = new Set<string>();
    value.stages.forEach((rawStage, stageIndex) => {
      const position = `stages[${stageIndex + 1}]`;
      if (!isRecord(rawStage) || !Array.isArray(rawStage.tasks) || rawStage.tasks.length === 0) {
        errors.push(`${position}: must have a non-empty tasks array`);
        return;
      }
      if (rawStage.tasks.length > MAX_TASKS_PER_STAGE) {
        errors.push(`${position}: at most ${MAX_TASKS_PER_STAGE} parallel tasks`);
        return;
      }
      const tasks: PipelineDocStep[] = [];
      rawStage.tasks.forEach((rawTask, taskIndex) => {
        const step = parseStep(rawTask, `${position}.tasks[${taskIndex + 1}]`, contracts, errors);
        if (step === undefined) return;
        if (seenIds.has(step.id)) {
          errors.push(`${position} (${step.id}): duplicate step id`);
          return;
        }
        seenIds.add(step.id);
        tasks.push(step);
      });
      stages.push({ tasks });
    });
  }

  if (errors.length > 0 || name === undefined) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    doc: { v: 1, name, description, orchestrator, sharing, stages },
  };
}

/**
 * Derive the capability set the doc actually needs — the task's
 * `required_capabilities`. Never user-picked: you cannot grant what the doc
 * doesn't use, and nothing is granted silently.
 */
export function deriveCapabilities(
  doc: PipelineDoc,
  contracts: Readonly<Record<string, OrchestrationContract>>,
): readonly Capability[] {
  const caps = new Set<Capability>(["WRITE_STORAGE"]);
  for (const stage of doc.stages) {
    for (const step of stage.tasks) {
      if (step.kind === "prompt") {
        caps.add("CLI_INVOKE");
      } else {
        caps.add("SPAWN_SUBAGENT");
        for (const cap of contracts[step.target]?.capabilities ?? []) caps.add(cap);
      }
    }
  }
  if (doc.orchestrator.enabled) caps.add("CLI_INVOKE");
  if (doc.sharing.memory) caps.add("READ_STORAGE");
  return [...caps];
}

/** Placeholder shape: `{{stages.<stageNumber>.<stepId>.result}}` (1-based stage). */
const RESULT_PLACEHOLDER_RE = /\{\{stages\.(\d+)\.([a-z0-9-]+)\.result\}\}/g;

/**
 * Replace known result placeholders; unknown ones are left VISIBLE in the prompt
 * (fail-visible beats silently sending an empty string). Keys are
 * `<stageNumber>.<stepId>` with the stage number 1-based.
 */
export function interpolateResults(prompt: string, results: ReadonlyMap<string, string>): string {
  return prompt.replace(RESULT_PLACEHOLDER_RE, (whole, stage: string, stepId: string) => {
    return results.get(`${stage}.${stepId}`) ?? whole;
  });
}
