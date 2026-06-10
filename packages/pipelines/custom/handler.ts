/**
 * The custom-pipeline interpreter (specs/pipeline-editor.md) — ONE generic engine
 * that runs a saved {@link PipelineDoc}: stages sequential, tasks within a stage
 * parallel, results piped forward, optional orchestrator re-authoring between
 * stages. There is deliberately NO second execution runtime here: prompt steps are
 * `ctx.complete`, pipeline steps ride the same contract path as chat orchestration
 * (`ctx.spawn` / sibling runs), and the scheduler owns guardrails, grants, run rows
 * and the live trace.
 *
 * Each saved pipeline registers its OWN handler id (`custom:<id>`, a closure over
 * this interpreter) so the per-task grant — keyed by handler_id — stays per-pipeline.
 */

import type { RunParams, TaskHandler } from "@vesper/core";
import type { OrchestrationContract } from "../router/contracts.ts";
import {
  interpolateResults,
  type PipelineDoc,
  type PipelineDocStep,
  type PromptStep,
  parsePipelineDoc,
} from "./doc.ts";
import {
  buildOrchestratorRevisionPrompt,
  parseOrchestratorRevision,
  type StageOutcome,
} from "./orchestrate.ts";

/** Task/handler id prefix for user-authored pipelines. */
export const CUSTOM_TASK_PREFIX = "custom:";

/** The `custom:<pipelineId>` task + handler id for a saved pipeline. */
export function customTaskId(pipelineId: string): string {
  return `${CUSTOM_TASK_PREFIX}${pipelineId}`;
}

/** Per-call timeout for prompt steps (generous: a step is a full agent turn). */
const PROMPT_STEP_TIMEOUT_MS = 300_000;
/** Per-call timeout for orchestrator revisions (a single structured reply). */
const ORCHESTRATOR_TIMEOUT_MS = 120_000;

/** Sibling-run launcher for `spawnsOwnChildren` targets (same seam as the router). */
export type RunSiblingFn = (
  handlerId: string,
  options: {
    readonly params: RunParams;
    readonly parentRunId: string;
    readonly model?: string;
  },
) => Promise<{
  readonly runId: string | null;
  readonly status: string | null;
  readonly summary: string | null;
} | null>;

/** Host-injected wiring for the interpreter. Everything optional degrades gracefully. */
export interface CustomPipelineDeps {
  /** Read the saved raw doc for a pipeline id (the store row's `doc`). */
  readonly getDoc: (pipelineId: string) => Record<string, unknown> | null;
  /** The orchestration contract map — the ONLY invocable pipeline targets. */
  readonly contracts: Readonly<Record<string, OrchestrationContract>>;
  /** Resolve a skill's markdown body by name (the SkillLibrary reader). */
  readonly getSkillBody?: (name: string) => Promise<string | null>;
  /** Resolve a target's editable template default params (parity with the router). */
  readonly getDefaultParams?: (handlerId: string) => RunParams;
  /** The benchmark frontier pick for the orchestrator when the doc pins no model. */
  readonly pickOrchestratorModel?: () => string | undefined;
  /** Sibling-run launcher for `spawnsOwnChildren` targets. */
  readonly runSibling?: RunSiblingFn;
  /** Semantic-memory search for `sharing.memory` docs (top-K snippet texts). */
  readonly searchMemory?: (query: string, k: number) => Promise<readonly string[]>;
}

interface TaskOutcome extends StageOutcome {
  readonly ok: boolean;
}

function isOkStatus(status: string): boolean {
  return status === "ok" || status === "succeeded";
}

/** Assemble a prompt step's effective prompt: command prefix, skills, memory, piping. */
function assemblePrompt(
  step: PromptStep,
  results: ReadonlyMap<string, string>,
  skillBodies: readonly { name: string; body: string }[],
  memoryHits: readonly string[],
): string {
  const parts: string[] = [];
  for (const skill of skillBodies) {
    parts.push(`## Skill: ${skill.name}\n\n${skill.body}`);
  }
  if (memoryHits.length > 0) {
    parts.push(`## Relevant memory\n\n${memoryHits.map((h) => `- ${h}`).join("\n")}`);
  }
  const body = interpolateResults(step.prompt, results);
  parts.push(step.command !== undefined ? `${step.command} ${body}` : body);
  return parts.join("\n\n");
}

/**
 * Create the interpreter handler bound to one saved pipeline id. The doc is read
 * FRESH from the store on every run (an edit applies to the next run, no restart).
 */
export function createCustomPipelineHandler(
  pipelineId: string,
  deps: CustomPipelineDeps,
): TaskHandler {
  return async (ctx) => {
    const raw = deps.getDoc(pipelineId);
    if (raw === null) {
      ctx.recordRun({
        status: "error",
        summary: `custom pipeline "${pipelineId}" was not found (archived?)`,
      });
      return;
    }
    const parsed = parsePipelineDoc(raw, deps.contracts);
    if (!parsed.ok) {
      ctx.recordRun({
        status: "error",
        summary: `custom pipeline "${pipelineId}" failed validation: ${parsed.errors.join("; ")}`,
      });
      return;
    }
    const doc = parsed.doc;
    const orchestratorModel = doc.orchestrator.model ?? deps.pickOrchestratorModel?.();

    // Optional semantic-memory grounding, fetched once and injected into stage 1.
    let memoryHits: readonly string[] = [];
    if (doc.sharing.memory && deps.searchMemory !== undefined) {
      memoryHits = await deps
        .searchMemory(`${doc.name} ${doc.description}`.trim(), 5)
        .catch(() => []);
    }

    const results = new Map<string, string>();
    const all: TaskOutcome[] = [];
    let prior: TaskOutcome[] = [];

    const runStep = async (step: PipelineDocStep, stageNumber: number): Promise<TaskOutcome> => {
      if (step.kind === "prompt") {
        const skillBodies: { name: string; body: string }[] = [];
        for (const name of step.skills) {
          const body = (await deps.getSkillBody?.(name).catch(() => null)) ?? null;
          if (body !== null) skillBodies.push({ name, body });
          else ctx.emitProgress({ kind: "log", message: `skill "${name}" not found — skipped` });
        }
        const prompt = assemblePrompt(
          step,
          results,
          skillBodies,
          stageNumber === 1 ? memoryHits : [],
        );
        ctx.emitProgress({
          kind: "step",
          message: `running prompt step "${step.title}"`,
          ...(step.model !== undefined ? { data: { model: step.model } } : {}),
        });
        try {
          const reply = await ctx.complete(prompt, {
            timeoutMs: PROMPT_STEP_TIMEOUT_MS,
            ...(step.cli !== undefined ? { cli: step.cli } : {}),
            ...(step.model !== undefined ? { model: step.model } : {}),
          });
          return { id: step.id, title: step.title, status: "ok", summary: reply.text, ok: true };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { id: step.id, title: step.title, status: "error", summary: message, ok: false };
        }
      }

      // Pipeline step — the contract path, identical clamps as chat orchestration.
      const contract = deps.contracts[step.target] as OrchestrationContract;
      const prompt = interpolateResults(step.prompt, results);
      const model = contract.acceptsModel ? step.model : undefined;
      const params: RunParams = {
        ...(deps.getDefaultParams?.(contract.handlerId) ?? {}),
        ...step.params,
        [contract.promptParam]: prompt,
      };

      if (contract.spawnsOwnChildren) {
        if (deps.runSibling === undefined) {
          return {
            id: step.id,
            title: step.title,
            status: "error",
            summary: `${step.target} needs the daemon's sibling runner — run this via the daemon`,
            ok: false,
          };
        }
        ctx.emitProgress({
          kind: "spawn",
          message: `launching ${step.target} (sibling run): ${step.title}`,
          ...(model !== undefined ? { data: { model } } : {}),
        });
        const outcome = await deps
          .runSibling(contract.handlerId, {
            params,
            parentRunId: ctx.runId,
            ...(model !== undefined ? { model } : {}),
          })
          .catch((err: unknown) => ({
            runId: null,
            status: "error",
            summary: err instanceof Error ? err.message : String(err),
          }));
        const status = outcome?.status ?? "error";
        return {
          id: step.id,
          title: step.title,
          status,
          summary: outcome?.summary ?? "(no result)",
          ok: isOkStatus(status),
        };
      }

      ctx.emitProgress({
        kind: "spawn",
        message: `spawning ${step.target}: ${step.title}`,
        ...(model !== undefined ? { data: { model } } : {}),
      });
      const handle = ctx.spawn({
        handlerId: contract.handlerId,
        label: step.title,
        params,
        capabilities: contract.capabilities,
        ...(model !== undefined ? { model } : {}),
      });
      const child = await handle.done.catch(() => null);
      const status = child?.status ?? "error";
      return {
        id: step.id,
        title: step.title,
        status,
        summary: child?.summary ?? "(the sub-agent failed)",
        ok: isOkStatus(status),
      };
    };

    for (let index = 0; index < doc.stages.length; index++) {
      const stage = doc.stages[index] as (typeof doc.stages)[number];
      const stageNumber = index + 1;
      let tasks: readonly PipelineDocStep[] = stage.tasks;

      // Mastermind pass: from stage 2 on, re-author this stage's prompts WITH the
      // prior outcomes. Fail-soft — a malformed revision keeps the originals.
      if (doc.orchestrator.enabled && index > 0 && prior.length > 0) {
        ctx.emitProgress({
          kind: "step",
          message: `orchestrator re-authoring stage ${stageNumber} prompts`,
          ...(orchestratorModel !== undefined ? { data: { model: orchestratorModel } } : {}),
        });
        const reply = await ctx
          .complete(buildOrchestratorRevisionPrompt(doc, tasks, prior), {
            timeoutMs: ORCHESTRATOR_TIMEOUT_MS,
            ...(orchestratorModel !== undefined ? { model: orchestratorModel } : {}),
          })
          .catch(() => null);
        const revised = reply === null ? null : parseOrchestratorRevision(reply.text);
        if (revised !== null) {
          tasks = tasks.map((t) =>
            revised[t.id] !== undefined ? { ...t, prompt: revised[t.id] as string } : t,
          );
        }
      }

      const settled = await Promise.allSettled(tasks.map((t) => runStep(t, stageNumber)));
      prior = settled.map((r, i) => {
        const fallbackId = tasks[i]?.id ?? "task";
        return r.status === "fulfilled"
          ? r.value
          : {
              id: fallbackId,
              title: tasks[i]?.title ?? fallbackId,
              status: "error",
              summary: r.reason instanceof Error ? r.reason.message : String(r.reason),
              ok: false,
            };
      });
      for (const outcome of prior) {
        results.set(`${stageNumber}.${outcome.id}`, outcome.summary);
      }
      all.push(...prior);
    }

    const allOk = all.every((o) => o.ok);
    const summary = all
      .map((o) => `[${o.status}] ${o.title}: ${o.summary.slice(0, 300)}`)
      .join("\n");
    ctx.recordRun({ status: allOk ? "ok" : "error", summary });
  };
}
