/**
 * The `router` pipeline — the chatbot-home dispatcher.
 *
 * A chat message is a manual run of THIS pipeline through the existing run path
 * (`POST /api/chat` -> `scheduler.run("router", { params })`). The handler reads the
 * user's message from `ctx.params.message`, asks the user's authenticated CLI
 * (`ctx.complete`, CLI_INVOKE — Hard rule 12, no provider SDK) to CLASSIFY it to ONE
 * label, maps that label through a FIXED ALLOWLIST to a registered handler id, and
 * `ctx.spawn`s that pipeline as a sub-agent (the live tree under the transcript turn).
 *
 * SAFETY (non-negotiable): the handler id is NEVER taken from the model's free-form
 * text. The classifier returns a label; only a label present in {@link ROUTE_ALLOWLIST}
 * resolves to a handler id. An unmapped/unknown/free-form label produces a
 * clarifying-question turn (a recorded run, NO spawn, NO dynamic handler id) — this
 * preserves the no-dynamic-eval invariant the scheduler relies on.
 *
 * Capabilities: `CLI_INVOKE` (classify), `WRITE_STORAGE` (record + emit trace),
 * `SPAWN_SUBAGENT` (dispatch). All asserted at the context boundary before any effect.
 */

import type { Capability, RegisterTaskInput, RunParams, TaskHandler } from "@vesper/core";
import {
  ORCHESTRATOR_DEMO_HANDLER_ID,
  orchestratorDemoTaskInput,
} from "../orchestrator-demo/handler.ts";
import { SELFTEST_HANDLER_ID, selftestTaskInput } from "../selftest/handler.ts";
import { ORCHESTRATION_CONTRACTS, type OrchestrationContract } from "./contracts.ts";
import {
  buildPlanPrompt,
  buildStepRevisionPrompt,
  type PlanDifficulty,
  type PlanTask,
  parseOrchestrationPlan,
  parseStepRevision,
} from "./plan.ts";

/** Allowlisted handler id referenced by the `router` task. */
export const ROUTER_HANDLER_ID = "router";

/**
 * The fixed label -> handler-id allowlist. The classifier may ONLY pick a key here;
 * the value is the registered handler id the router spawns. Anything outside this map
 * (including a free-form id the model might emit) is refused and becomes a clarifying
 * turn. Built-in spawn targets only — flagship pipelines extend this map as they land.
 */
export const ROUTE_ALLOWLIST: Readonly<Record<string, string>> = {
  selftest: "selftest",
  orchestrate: "orchestrator-demo",
} as const;

/**
 * The capabilities each allowlisted spawn target is granted — exactly what ITS task
 * declares (the single source of truth is each target's `required_capabilities`).
 * The router task requires the UNION of these (CLI_INVOKE + WRITE_STORAGE +
 * SPAWN_SUBAGENT), so every grant here is within the router run's ceiling. Granting
 * a flat `WRITE_STORAGE` denied `selftest` (needs CLI_INVOKE) and `orchestrate`
 * (needs SPAWN_SUBAGENT) at the child's context boundary — the chatbot-home bug.
 */
const CHILD_CAPABILITIES_BY_HANDLER: Readonly<Record<string, readonly Capability[]>> = {
  [SELFTEST_HANDLER_ID]: selftestTaskInput.required_capabilities ?? [],
  [ORCHESTRATOR_DEMO_HANDLER_ID]: orchestratorDemoTaskInput.required_capabilities ?? [],
};

/**
 * Fallback grant for a custom-allowlist target with no declared mapping (record +
 * trace only). The built-in allowlist always resolves above; this bounds an
 * unknown injected target to the least privilege rather than the router's full union.
 */
const DEFAULT_CHILD_CAPABILITIES: readonly Capability[] = ["WRITE_STORAGE"];

/** Max characters of the user message embedded in the classify prompt (bound the prompt). */
const MESSAGE_MAX_LENGTH = 2_000;

/** Minimum interval between streamed text-delta flushes (coalescing window, ms). */
const DELTA_FLUSH_MS = 75;

/**
 * A frozen snapshot of the runtime the orchestrator answers FROM — ground truth,
 * not model memory. Host-injected (the daemon builds it from the pipeline
 * registry, the runs table, and the schedule list).
 */
export interface RuntimeContextSnapshot {
  readonly pipelines: readonly { readonly id: string; readonly summary: string }[];
  readonly recentRuns: readonly {
    readonly pipeline: string;
    readonly status: string;
    readonly summary: string;
    readonly ts: number;
  }[];
  readonly schedules: readonly {
    readonly id: string;
    readonly kind: string;
    readonly schedule_expr: string;
    readonly enabled: boolean;
  }[];
}

/** The empty snapshot used when the host wired no runtime-context provider. */
const EMPTY_SNAPSHOT: RuntimeContextSnapshot = { pipelines: [], recentRuns: [], schedules: [] };

/**
 * Build the ANSWER prompt: Vesper speaks as the orchestrator, grounded in the
 * runtime snapshot (so "what pipelines are available?" is answered from ground
 * truth). The user message is fenced; the reply is plain conversational text.
 */
function buildAnswerPrompt(message: string, snapshot: RuntimeContextSnapshot): string {
  const pipelines =
    snapshot.pipelines.length > 0
      ? snapshot.pipelines.map((p) => `- ${p.id}: ${p.summary}`).join("\n")
      : "(none registered)";
  const runs =
    snapshot.recentRuns.length > 0
      ? snapshot.recentRuns
          .map((r) => `- [${r.status}] ${r.pipeline}: ${r.summary.slice(0, 120)}`)
          .join("\n")
      : "(no recent runs)";
  const schedules =
    snapshot.schedules.length > 0
      ? snapshot.schedules
          .map(
            (s) =>
              `- ${s.id} (${s.kind}${s.schedule_expr ? ` ${s.schedule_expr}` : ""}, ${s.enabled ? "enabled" : "disabled"})`,
          )
          .join("\n")
      : "(none)";

  return [
    "You are Vesper, a local-first personal automation runtime, talking to your owner.",
    "Answer their message conversationally and concretely FROM the runtime state below —",
    "this is ground truth; do not invent pipelines or runs that are not listed.",
    "Be brief and useful. Plain text only (no markdown headers).",
    "",
    "Registered pipelines:",
    pipelines,
    "",
    "Recent runs (newest last):",
    runs,
    "",
    "Schedules:",
    schedules,
    "",
    "Owner's message:",
    "<<<",
    message,
    ">>>",
  ].join("\n");
}

/** Read the user message from params; empty string when absent/non-string. */
function readMessage(params: RunParams): string {
  const raw = params.message;
  return typeof raw === "string" ? raw.slice(0, MESSAGE_MAX_LENGTH) : "";
}

/**
 * Build the classify prompt: the model must answer with EXACTLY one label from the
 * allowlist (or the literal `none`). The allowlist is interpolated so the model knows
 * the closed set; the user's message is fenced so it cannot rewrite the instruction.
 */
function buildClassifyPrompt(message: string, labels: readonly string[]): string {
  return [
    "You are a strict intent classifier for a local automation runtime.",
    `Choose EXACTLY ONE label from this closed set: ${labels.join(", ")}, run, answer, none.`,
    "Pick a pipeline label ONLY when the user asks to run exactly that one automation. Pick",
    '"run" when they ask for WORK to be done that needs planning or combines pipelines',
    '(e.g. naming several pipelines, or a multi-part task). Pick "answer" when they are',
    "asking a question, conversing, or asking about the runtime itself (its pipelines,",
    'runs, schedules, status). Use "none" when the request is ambiguous.',
    "Answer with the single label only — no punctuation, no explanation.",
    "",
    "User request:",
    "<<<",
    message,
    ">>>",
  ].join("\n");
}

/**
 * Normalise the model's reply to a label key: trim, lowercase, and keep only the first
 * token of word characters. A reply that is not an exact allowlist key resolves to null
 * (treated as `none`) — the model can never inject an arbitrary handler id this way.
 */
function resolveLabel(reply: string, allowlist: Readonly<Record<string, string>>): string | null {
  const token =
    reply
      .trim()
      .toLowerCase()
      .match(/[a-z0-9_-]+/)?.[0] ?? "";
  return Object.hasOwn(allowlist, token) ? token : null;
}

/** Dependencies that make the router handler unit-testable; all default to the built-ins. */
export interface RouterHandlerOptions {
  /** The label -> handler-id allowlist. Defaults to {@link ROUTE_ALLOWLIST}. */
  readonly allowlist?: Readonly<Record<string, string>>;
  /**
   * Returns the editable template `default_params` for a target handler id, which the
   * router MERGES under the user message into the spawn params (so an edited pipeline
   * template actually affects its runs — #4). Host-injected (the daemon wires it to
   * `store.getTemplate`); defaults to no defaults when absent (tests / non-daemon).
   */
  readonly getDefaultParams?: (handlerId: string) => RunParams;
  /**
   * Returns the live {@link RuntimeContextSnapshot} the `answer` action grounds in.
   * Host-injected (the daemon builds it from the registry + store + schedule list);
   * absent -> answers carry an empty snapshot (tests / non-daemon callers).
   */
  readonly getRuntimeContext?: () => RuntimeContextSnapshot;
  /** The orchestration-contract map. Defaults to {@link ORCHESTRATION_CONTRACTS}. */
  readonly contracts?: Readonly<Record<string, OrchestrationContract>>;
  /**
   * Benchmark-driven model pick for a plan task with no explicit model: returns a
   * canonical catalog id (or undefined = no override). Host-injected (selectModel
   * over the persisted snapshot); absent -> no model overrides.
   */
  readonly pickModel?: (difficulty: PlanDifficulty) => string | undefined;
  /**
   * Model for the router's OWN brain calls (classify / answer / plan author /
   * step revision) — the orchestrator-by-default pattern (specs/pipeline-editor.md).
   * A `params.orchestratorModel` on the run wins; host-injected resolution is
   * template default > benchmark frontier pick > config default. Absent -> the
   * configured CLI default (prior behavior).
   */
  readonly pickOrchestratorModel?: () => string | undefined;
  /**
   * Launch a `spawnsOwnChildren` plan task as a sibling TOP-LEVEL run (display
   * lineage via parentRunId; the run keeps its task's own declared capabilities
   * and may spawn its own children — the depth-1 answer). Host-injected
   * (`scheduler.run`); absent -> such tasks fail soft with a clear summary.
   */
  readonly runSibling?: (
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
}

/** One executed plan task's outcome (feeds the next step's prompt revision). */
interface TaskOutcome {
  readonly label: string;
  readonly status: string;
  readonly summary: string;
  readonly runId: string | null;
}

/**
 * Build the router handler. The default export {@link routerHandler} uses the built-in
 * allowlist; tests inject a custom allowlist to assert dispatch + the no-eval fallback.
 */
export function makeRouterHandler(options: RouterHandlerOptions = {}): TaskHandler {
  const allowlist = options.allowlist ?? ROUTE_ALLOWLIST;
  const getDefaultParams = options.getDefaultParams;
  const getRuntimeContext = options.getRuntimeContext;
  const contracts = options.contracts ?? ORCHESTRATION_CONTRACTS;
  const pickModel = options.pickModel;
  const runSibling = options.runSibling;
  const labels = Object.keys(allowlist);

  return async (ctx) => {
    const message = readMessage(ctx.params);
    // The router IS the orchestrator — its own brain calls run on the
    // orchestrator model (run param > host pick > none = configured default).
    const orchestratorModel =
      (typeof ctx.params.orchestratorModel === "string" &&
      ctx.params.orchestratorModel.trim().length > 0
        ? ctx.params.orchestratorModel.trim()
        : undefined) ?? options.pickOrchestratorModel?.();
    const brainOpts =
      orchestratorModel !== undefined ? { model: orchestratorModel } : ({} as const);

    if (message.trim().length === 0) {
      ctx.emitProgress({ kind: "step", message: "empty message — asking for clarification" });
      ctx.recordRun({
        status: "clarify",
        summary: "I did not catch that — could you say what you would like me to do?",
      });
      return;
    }

    ctx.emitProgress({ kind: "step", message: "classifying request" });
    const result = await ctx.complete(buildClassifyPrompt(message, labels), { ...brainOpts });
    const token =
      result.text
        .trim()
        .toLowerCase()
        .match(/[a-z0-9_-]+/)?.[0] ?? "";

    // ANSWER: the orchestrator replies conversationally, grounded in the live
    // runtime snapshot, STREAMING deltas to the chat (publish-only "text" kind;
    // the io result event is the durable record).
    if (token === "answer") {
      ctx.emitProgress({ kind: "step", message: "answering from runtime context" });
      const snapshot = getRuntimeContext?.() ?? EMPTY_SNAPSHOT;
      const sessionId = typeof ctx.params.sessionId === "string" ? ctx.params.sessionId : undefined;

      let pending = "";
      let lastFlush = 0;
      const flush = (force: boolean): void => {
        if (pending.length === 0) return;
        const now = Date.now();
        if (!force && now - lastFlush < DELTA_FLUSH_MS) return;
        ctx.emitProgress({
          kind: "text",
          message: pending,
          ...(sessionId !== undefined ? { data: { sessionId } } : {}),
        });
        pending = "";
        lastFlush = now;
      };

      // Generous per-call timeout: a grounded conversational answer can exceed the
      // 30s process default (slice A made the override reach the adapter).
      const reply = await ctx.complete(buildAnswerPrompt(message, snapshot), {
        timeoutMs: 120_000,
        ...brainOpts,
        onText: (delta) => {
          pending += delta;
          flush(false);
        },
      });
      flush(true);

      const answer = reply.text.trim();
      ctx.recordRun({
        status: "ok",
        summary: answer.length > 0 ? answer : "(no response)",
      });
      return;
    }

    // RUN: author an orchestration plan (Vesper writes every sub-agent prompt),
    // then execute it — steps sequential, tasks within a step parallel.
    if (token === "run") {
      ctx.emitProgress({ kind: "step", message: "planning the work" });
      const planReply = await ctx.complete(buildPlanPrompt(message, contracts), {
        timeoutMs: 120_000,
        ...brainOpts,
      });
      const plan = parseOrchestrationPlan(planReply.text, contracts);
      if (plan === null) {
        ctx.recordRun({
          status: "clarify",
          summary:
            "I could not turn that into a plan over my pipelines. Could you say which " +
            "pipeline(s) you want, or describe the task differently?",
        });
        return;
      }
      const total = plan.steps.reduce((n, s) => n + s.tasks.length, 0);
      ctx.emitProgress({
        kind: "step",
        message: `plan ready: ${total} task(s) across ${plan.steps.length} step(s)`,
        ...(plan.notes.length > 0 ? { data: { notes: plan.notes } } : {}),
      });

      const runTask = async (task: PlanTask): Promise<TaskOutcome> => {
        const contract = contracts[task.pipeline] as OrchestrationContract;
        const model = contract.acceptsModel
          ? (task.model ?? pickModel?.(task.difficulty))
          : undefined;
        const templateParams = getDefaultParams?.(contract.handlerId) ?? {};
        const params: RunParams = {
          ...templateParams,
          ...task.params,
          [contract.promptParam]: task.prompt,
        };

        if (contract.spawnsOwnChildren) {
          // Sibling top-level run (depth-1 answer): display lineage only; the run
          // keeps its task's own declared capabilities and may spawn children.
          if (runSibling === undefined) {
            return {
              label: task.label,
              status: "error",
              summary: `${task.pipeline} needs the daemon's sibling runner — run this via the daemon`,
              runId: null,
            };
          }
          ctx.emitProgress({
            kind: "spawn",
            message: `launching ${task.pipeline} (sibling run): ${task.label}`,
            ...(model !== undefined ? { data: { model } } : {}),
          });
          const outcome = await runSibling(contract.handlerId, {
            params,
            parentRunId: ctx.runId,
            ...(model !== undefined ? { model } : {}),
          }).catch((err: unknown) => ({
            runId: null,
            status: "error",
            summary: err instanceof Error ? err.message : String(err),
          }));
          return {
            label: task.label,
            status: outcome?.status ?? "error",
            summary: outcome?.summary ?? "(no result)",
            runId: outcome?.runId ?? null,
          };
        }

        ctx.emitProgress({
          kind: "spawn",
          message: `spawning ${task.pipeline}: ${task.label}`,
          ...(model !== undefined ? { data: { model } } : {}),
        });
        const handle = ctx.spawn({
          handlerId: contract.handlerId,
          label: task.label,
          params,
          capabilities: contract.capabilities,
          ...(model !== undefined ? { model } : {}),
        });
        const childOutcome = await handle.done.catch(() => null);
        return {
          label: task.label,
          status: childOutcome?.status ?? "error",
          summary: childOutcome?.summary ?? "(the sub-agent failed)",
          runId: handle.runId,
        };
      };

      let prior: TaskOutcome[] = [];
      const all: TaskOutcome[] = [];
      for (let index = 0; index < plan.steps.length; index++) {
        const step = plan.steps[index] as (typeof plan.steps)[number];
        let tasks: readonly PlanTask[] = step.tasks;

        // Result piping: from the second step on, re-author the prompts WITH the
        // prior outcomes. A failed revision keeps the original prompts (fail-soft).
        if (index > 0 && prior.length > 0) {
          ctx.emitProgress({
            kind: "step",
            message: `re-authoring step ${index + 1} prompts from prior results`,
          });
          const revisionReply = await ctx
            .complete(buildStepRevisionPrompt(message, tasks, prior), {
              timeoutMs: 120_000,
              ...brainOpts,
            })
            .catch(() => null);
          const revised = revisionReply === null ? null : parseStepRevision(revisionReply.text);
          if (revised !== null) {
            tasks = tasks.map((t) =>
              revised[t.label] !== undefined ? { ...t, prompt: revised[t.label] as string } : t,
            );
          }
        }

        const settled = await Promise.allSettled(tasks.map(runTask));
        prior = settled.map((r, i) =>
          r.status === "fulfilled"
            ? r.value
            : {
                label: tasks[i]?.label ?? "task",
                status: "error",
                summary: r.reason instanceof Error ? r.reason.message : String(r.reason),
                runId: null,
              },
        );
        all.push(...prior);
      }

      const allOk = all.every((o) => o.status === "ok" || o.status === "succeeded");
      const summary = all
        .map((o) => `[${o.status}] ${o.label}: ${o.summary}`)
        .join("\n")
        .slice(0, 4_000);
      ctx.recordRun({
        status: allOk ? "ok" : "partial",
        summary: summary.length > 0 ? summary : "the plan produced no output",
      });
      return;
    }

    const label = resolveLabel(result.text, allowlist);

    // No-eval fallback: an unmapped/free-form label NEVER becomes a handler id.
    if (label === null) {
      ctx.emitProgress({
        kind: "step",
        message: "no matching pipeline — asking for clarification",
      });
      ctx.recordRun({
        status: "clarify",
        summary:
          "I am not sure which automation fits that. Could you rephrase, or tell me the task " +
          "in a few words?",
      });
      return;
    }

    const handlerId = allowlist[label] as string;
    ctx.emitProgress({
      kind: "spawn",
      message: `dispatching to "${handlerId}"`,
      data: { label, handlerId },
    });

    // Merge the target's editable template default_params UNDER the user message, so an
    // edited template configures its runs (#4) without ever overriding the message.
    const templateParams = getDefaultParams?.(handlerId) ?? {};
    const handle = ctx.spawn({
      handlerId,
      label,
      params: { ...templateParams, message },
      capabilities: CHILD_CAPABILITIES_BY_HANDLER[handlerId] ?? DEFAULT_CHILD_CAPABILITIES,
    });
    const childOutcome = await handle.done.catch(() => null);

    // Surface the child pipeline's ACTUAL answer as the assistant reply, not a routing
    // receipt: `POST /api/chat` uses THIS run's summary as the assistant turn's text, so
    // discarding the child's summary is exactly why the chat showed "routed to selftest
    // (run ...)" with no answer. The run linkage ("Watch it work" + the live activity
    // tree) rides on this run's own id, so the activity stays available even though the
    // summary now carries the answer itself. A null outcome means the child threw
    // (timeout / CLI failure); an empty summary means it recorded nothing — both get a
    // plain-language fallback that still points at the run for inspection.
    const answer = childOutcome?.summary?.trim() ?? "";
    ctx.recordRun({
      status: childOutcome?.status === "ok" ? "ok" : "partial",
      summary:
        answer.length > 0
          ? answer
          : `The ${handlerId} pipeline ran but returned no response (run ${handle.runId}).`,
    });
  };
}

/** The built-in router handler (default allowlist). */
export const routerHandler: TaskHandler = makeRouterHandler();

/**
 * Manual task wiring for the `router` pipeline. Requires `CLI_INVOKE` (classify),
 * `WRITE_STORAGE` (record + emit trace), and `SPAWN_SUBAGENT` (dispatch).
 */
export const routerTaskInput: RegisterTaskInput = {
  id: "router",
  kind: "manual",
  schedule_expr: "",
  handler_id: ROUTER_HANDLER_ID,
  max_duration_ms: 120_000,
  required_capabilities: ["CLI_INVOKE", "WRITE_STORAGE", "SPAWN_SUBAGENT"],
};
