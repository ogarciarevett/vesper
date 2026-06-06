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
    `Choose EXACTLY ONE label from this closed set: ${labels.join(", ")}, none.`,
    'Answer with the single label only — no punctuation, no explanation. Use "none" when',
    "the request matches no label or is ambiguous.",
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
}

/**
 * Build the router handler. The default export {@link routerHandler} uses the built-in
 * allowlist; tests inject a custom allowlist to assert dispatch + the no-eval fallback.
 */
export function makeRouterHandler(options: RouterHandlerOptions = {}): TaskHandler {
  const allowlist = options.allowlist ?? ROUTE_ALLOWLIST;
  const getDefaultParams = options.getDefaultParams;
  const labels = Object.keys(allowlist);

  return async (ctx) => {
    const message = readMessage(ctx.params);

    if (message.trim().length === 0) {
      ctx.emitProgress({ kind: "step", message: "empty message — asking for clarification" });
      ctx.recordRun({
        status: "clarify",
        summary: "I did not catch that — could you say what you would like me to do?",
      });
      return;
    }

    ctx.emitProgress({ kind: "step", message: "classifying request" });
    const result = await ctx.complete(buildClassifyPrompt(message, labels));
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
