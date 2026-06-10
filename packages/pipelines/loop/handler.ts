/**
 * The `loop` pipeline — the autonomous-loop engine wrapped as a registered
 * handler (`specs/autonomous-loop.md`, DEV-113). The human supplies just an
 * objective (`goal` param); per iteration the model AUTHORs the next prompt,
 * EXECUTEs it, and a CRITIC judges the result, all over `ctx.complete`.
 *
 * v1 is a *reasoning* loop: the executor is pure text-in/text-out, so the task
 * declares exactly `CLI_INVOKE` (the three roles) + `WRITE_STORAGE`
 * (recordRun/emitProgress) and nothing more — the loop cannot write files, hit
 * the network, or notify.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import {
  type AppendEventInput,
  LOOP_DEFAULT_MAX_ITERATIONS,
  LOOP_MAX_ITERATIONS_CEILING,
  type LoopRoles,
  type LoopSpec,
  openStore,
  type RegisterTaskInput,
  runLoop,
  type TaskHandler,
} from "@vesper/core";

/** Allowlisted handler id referenced by the `loop` task. */
export const LOOP_HANDLER_ID = "loop";

/** Injected seam so the handler is unit-testable without a real DB. */
export interface LoopHandlerDeps {
  /** Append the per-iteration audit row to the `events` table. */
  readonly appendEvent: (input: AppendEventInput) => string;
}

/** Read an optional positive-integer param (number or numeric string). */
function intParam(params: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const raw = params[key];
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Read an optional non-empty string param. */
function strParam(params: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const raw = params[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

/**
 * Build the {@link LoopSpec} from run params. Fails fast on a missing/empty
 * `goal` (before any CLI call); `maxIterations` is clamped to the hard ceiling.
 */
export function buildLoopSpec(params: Readonly<Record<string, unknown>>): LoopSpec {
  const goal = strParam(params, "goal");
  if (goal === undefined) {
    throw new Error("the loop pipeline requires a non-empty `goal` param (the objective)");
  }
  const successCriteria = strParam(params, "successCriteria");
  const maxIterations = Math.min(
    intParam(params, "maxIterations") ?? LOOP_DEFAULT_MAX_ITERATIONS,
    LOOP_MAX_ITERATIONS_CEILING,
  );
  const maxNoProgress = intParam(params, "maxNoProgress");
  const maxTotalMs = intParam(params, "maxTotalMs");
  const authorCli = strParam(params, "authorCli");
  const executeCli = strParam(params, "executeCli");
  const criticCli = strParam(params, "criticCli");
  const orchestratorModel = strParam(params, "orchestratorModel");
  const roles: LoopRoles = {
    ...(authorCli !== undefined ? { authorCli } : {}),
    ...(executeCli !== undefined ? { executeCli } : {}),
    ...(criticCli !== undefined ? { criticCli } : {}),
    ...(orchestratorModel !== undefined ? { orchestratorModel } : {}),
  };

  return {
    objective: { goal, ...(successCriteria !== undefined ? { successCriteria } : {}) },
    ...(Object.keys(roles).length > 0 ? { roles } : {}),
    bounds: {
      maxIterations,
      ...(maxNoProgress !== undefined ? { maxNoProgress } : {}),
      ...(maxTotalMs !== undefined ? { maxTotalMs } : {}),
    },
  };
}

/** Build the `loop` handler with the injected audit-write seam. */
export function createLoopHandler(deps: LoopHandlerDeps): TaskHandler {
  return async (ctx) => {
    const spec = buildLoopSpec(ctx.params);
    await runLoop(ctx, spec, { appendEvent: deps.appendEvent });
  };
}

/**
 * Production seam: append audit events through a freshly-opened store (closed
 * after each write). Import-time inert — nothing opens until a loop iterates —
 * so the pure unit suite never touches the filesystem (the `auto-evolve` pattern).
 */
const defaultDeps: LoopHandlerDeps = {
  appendEvent: (input) => {
    const store = openStore(join(homedir(), ".vesper", "vesper.db"));
    try {
      return store.appendEvent(input);
    } finally {
      store.close();
    }
  },
};

/** The default `loop` handler used by the static pipeline registry. */
export const loopHandler: TaskHandler = createLoopHandler(defaultDeps);

/**
 * Manual task wiring for the `loop` pipeline. The declared set is EXACTLY
 * `CLI_INVOKE` + `WRITE_STORAGE` — the v1 safety boundary. `max_duration_ms` is
 * the task-layer wall-clock guardrail above the engine's own `maxTotalMs` bound
 * (a full 8-iteration loop is up to 24 CLI calls).
 */
export const loopTaskInput: RegisterTaskInput = {
  id: "loop",
  kind: "manual",
  schedule_expr: "",
  handler_id: LOOP_HANDLER_ID,
  max_duration_ms: 1_800_000,
  required_capabilities: ["CLI_INVOKE", "WRITE_STORAGE"],
};
