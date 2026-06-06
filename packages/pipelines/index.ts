/**
 * `@vesper/pipelines` — the registry of built-in Vesper pipelines.
 *
 * Each pipeline is described by a {@link PipelineDescriptor}: a handler, the id it
 * is registered under, and the manual/scheduled task wiring. The host calls
 * {@link registerPipelines} to install every descriptor into a scheduler so the
 * daemon's `HandlerRegistry` is no longer empty and `vesper schedule list` shows
 * the available pipelines.
 */

import {
  type Capability,
  type HandlerRegistry,
  type RegisterTaskInput,
  type RunParams,
  type Scheduler,
  SchedulerError,
  type TaskHandler,
} from "@vesper/core";
import {
  AUTO_EVOLVE_HANDLER_ID,
  autoEvolveHandler,
  autoEvolveTaskInput,
} from "./auto-evolve/handler.ts";
import {
  DEMO_WORKER_HANDLER_ID,
  demoWorkerHandler,
  ORCHESTRATOR_DEMO_HANDLER_ID,
  orchestratorDemoHandler,
  orchestratorDemoTaskInput,
} from "./orchestrator-demo/handler.ts";
import {
  makeRouterHandler,
  ROUTE_ALLOWLIST,
  ROUTER_HANDLER_ID,
  routerHandler,
  routerTaskInput,
} from "./router/handler.ts";
import { SELFTEST_HANDLER_ID, selftestHandler, selftestTaskInput } from "./selftest/handler.ts";
import {
  SKILL_TRAIN_HANDLER_ID,
  skillTrainHandler,
  skillTrainTaskInput,
} from "./skill-train/handler.ts";
import {
  type ChangeDecisionCoordinator,
  createSoftwareEngineerHandler,
  createSweBuildHandler,
  defaultBuildDeps,
  defaultLeadDeps,
  SOFTWARE_ENGINEER_HANDLER_ID,
  SWE_BUILD_HANDLER_ID,
  softwareEngineerTaskInput,
} from "./software-engineer/index.ts";

export type { ChangeDecision, ParsedDiff, SweBuildDeps } from "./software-engineer/index.ts";

// Re-export the software-engineer host surface so the daemon (cli) can wire the
// shared coordinator and the UI diff/decision provider through `@vesper/pipelines`.
export {
  ChangeDecisionCoordinator,
  ChangeDecisionError,
  makeGitRunner,
  parseUnifiedDiff,
  SWE_SOURCE,
} from "./software-engineer/index.ts";
export {
  AUTO_EVOLVE_HANDLER_ID,
  autoEvolveHandler,
  autoEvolveTaskInput,
  DEMO_WORKER_HANDLER_ID,
  demoWorkerHandler,
  ORCHESTRATOR_DEMO_HANDLER_ID,
  orchestratorDemoHandler,
  orchestratorDemoTaskInput,
  ROUTE_ALLOWLIST,
  ROUTER_HANDLER_ID,
  routerHandler,
  routerTaskInput,
  SELFTEST_HANDLER_ID,
  SKILL_TRAIN_HANDLER_ID,
  SOFTWARE_ENGINEER_HANDLER_ID,
  SWE_BUILD_HANDLER_ID,
  selftestHandler,
  selftestTaskInput,
  skillTrainHandler,
  skillTrainTaskInput,
  softwareEngineerTaskInput,
};

/**
 * Self-contained description of a built-in pipeline: a handler plus optional task
 * wiring. A descriptor with `taskInput` registers a runnable/scheduled task; one
 * WITHOUT (e.g. a spawn-only sub-agent worker) registers the handler only, so a
 * parent pipeline can `ctx.spawn` it by id without it appearing in `schedule list`.
 */
export interface PipelineDescriptor {
  readonly handlerId: string;
  readonly handler: TaskHandler;
  readonly taskInput?: RegisterTaskInput;
}

/**
 * Default lead handler used until the daemon wires the shared decision coordinator.
 * The lead's human-approval gate needs the coordinator the UI decision route also
 * holds; without it a run could never be approved, so the un-wired default fails
 * fast instead of hanging. `registerPipelines` overrides this when a coordinator is
 * supplied (see {@link RegisterPipelinesOptions.softwareEngineerCoordinator}).
 */
const softwareEngineerUnwired: TaskHandler = (ctx) => {
  ctx.recordRun({
    status: "error",
    summary:
      "software-engineer pipeline is not wired (no decision coordinator) — run via the daemon",
  });
};

/** Every built-in Vesper pipeline. */
export const PIPELINES: readonly PipelineDescriptor[] = [
  {
    handlerId: SELFTEST_HANDLER_ID,
    handler: selftestHandler,
    taskInput: selftestTaskInput,
  },
  // The chatbot-home dispatcher: a chat message is a manual run of this pipeline. It
  // classifies the wish via the CLI and spawns one allowlisted built-in. Adds
  // CLI_INVOKE + WRITE_STORAGE + SPAWN_SUBAGENT to the host grant union.
  {
    handlerId: ROUTER_HANDLER_ID,
    handler: routerHandler,
    taskInput: routerTaskInput,
  },
  {
    handlerId: SKILL_TRAIN_HANDLER_ID,
    handler: skillTrainHandler,
    taskInput: skillTrainTaskInput,
  },
  {
    handlerId: ORCHESTRATOR_DEMO_HANDLER_ID,
    handler: orchestratorDemoHandler,
    taskInput: orchestratorDemoTaskInput,
  },
  // Self-reflection: a daily, OPT-IN (enabled:false) cron that reads the runtime's
  // own health, reflects via the user's CLI, and writes proposals to `events`. The
  // default declared set is proposal-only (no PROCESS_RUN) — it cannot shell out.
  {
    handlerId: AUTO_EVOLVE_HANDLER_ID,
    handler: autoEvolveHandler,
    taskInput: autoEvolveTaskInput,
  },
  // The flagship: a visualized, human-gated coding cycle in a throwaway git
  // worktree. The lead spawns one `swe:build` sub-agent per file-disjoint task,
  // shows the diff, BLOCKS on a token-gated human decision, then stages a single
  // Conventional Commit and STOPS (never commits/merges/pushes). Declares the full
  // lead capability superset so the host ceiling covers the spawn-only build child.
  {
    handlerId: SOFTWARE_ENGINEER_HANDLER_ID,
    handler: softwareEngineerUnwired,
    taskInput: softwareEngineerTaskInput,
  },
  // Spawn-only worker: registered as a handler so orchestrator-demo can `ctx.spawn`
  // it, but it has no task of its own (not shown in `schedule list`).
  {
    handlerId: DEMO_WORKER_HANDLER_ID,
    handler: demoWorkerHandler,
  },
  // Spawn-only BUILD sub-agent for the software-engineer pipeline: writes files into
  // the worktree. Registered so the lead can `ctx.spawn` it by id; no task of its own.
  {
    handlerId: SWE_BUILD_HANDLER_ID,
    handler: createSweBuildHandler(defaultBuildDeps()),
  },
];

/**
 * The exact set of capabilities the built-in pipelines need — the union of every
 * registered pipeline's `required_capabilities`. The host grants THIS instead of
 * the full capability set, so the scheduler's capability check stays meaningful
 * (deny-by-default): a task can never receive a capability no pipeline declared.
 */
export function grantedCapabilities(): Capability[] {
  const granted = new Set<Capability>();
  for (const descriptor of PIPELINES) {
    for (const capability of descriptor.taskInput?.required_capabilities ?? []) {
      granted.add(capability);
    }
  }
  return [...granted];
}

/**
 * Install every built-in pipeline into the given scheduler.
 *
 * For each descriptor: register the handler FIRST (so the scheduler can resolve
 * `handler_id`), then register the task. Idempotent — an already-registered task
 * surfaces `duplicate_task`, which is swallowed; any other {@link SchedulerError}
 * (e.g. `unknown_handler`, `invalid_cron`) is re-thrown.
 *
 * `scheduler.register()` writes each pipeline's per-task capability grant (equal to
 * its `required_capabilities`) — including on the swallowed `duplicate_task` path —
 * so a daemon restart backfills grants for tasks persisted before per-task grants
 * existed. No grant writing happens here; that would duplicate the ceiling check.
 */
/** Host-injected wiring for built-in pipelines (e.g. the router's template reader). */
export interface RegisterPipelinesOptions {
  /**
   * Resolves a target handler's editable template `default_params` so the `router`
   * merges them into spawn params (#4). When omitted, the router uses no defaults
   * (the built-in handler), so non-daemon callers and tests behave unchanged.
   */
  readonly getDefaultParams?: (handlerId: string) => RunParams;
  /**
   * The shared decision coordinator that bridges a running software-engineer cycle
   * and the UI decision route. When provided, the lead handler is wired with the
   * production cycle seams (git, store, worktree TEST) bound to this coordinator;
   * when omitted, the lead registers as an un-wired fail-fast handler.
   */
  readonly softwareEngineerCoordinator?: ChangeDecisionCoordinator;
}

/** Resolve the handler to register for a descriptor, applying any host-injected wiring. */
function resolveHandler(
  descriptor: PipelineDescriptor,
  options: RegisterPipelinesOptions,
): TaskHandler {
  if (descriptor.handlerId === ROUTER_HANDLER_ID && options.getDefaultParams !== undefined) {
    return makeRouterHandler({ getDefaultParams: options.getDefaultParams });
  }
  if (
    descriptor.handlerId === SOFTWARE_ENGINEER_HANDLER_ID &&
    options.softwareEngineerCoordinator !== undefined
  ) {
    return createSoftwareEngineerHandler(defaultLeadDeps(options.softwareEngineerCoordinator));
  }
  return descriptor.handler;
}

export function registerPipelines(
  scheduler: Scheduler,
  registry: HandlerRegistry,
  options: RegisterPipelinesOptions = {},
): void {
  for (const descriptor of PIPELINES) {
    // The daemon injects the template reader into the router and the shared decision
    // coordinator into the software-engineer lead; every other handler registers as
    // declared.
    registry.register(descriptor.handlerId, resolveHandler(descriptor, options));

    // Spawn-only descriptors (no taskInput) register the handler only.
    if (descriptor.taskInput === undefined) continue;

    try {
      scheduler.register(descriptor.taskInput);
    } catch (error: unknown) {
      if (error instanceof SchedulerError && error.reason === "duplicate_task") {
        continue;
      }
      throw error;
    }
  }
}
