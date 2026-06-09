import type { EvolveSignals } from "../auto-evolve/types.ts";
import type { Capability } from "../capabilities/index.ts";
import type { CompleteResult } from "../cli/types.ts";

// Re-exported so scheduler consumers (and tests) can import the capability type
// from the scheduler surface without reaching into the capabilities module.
export type { Capability };

/** The kind of trigger that activates a scheduled task. */
export type TaskKind = "cron" | "event" | "manual";

/**
 * A persisted scheduled task record.
 *
 * - `kind = "cron"`: `schedule_expr` is a standard 5-field cron expression.
 * - `kind = "event"`: `schedule_expr` is the event topic to subscribe to.
 * - `kind = "manual"`: `schedule_expr` is `""` (no automatic trigger).
 */
export interface ScheduledTask {
  readonly id: string;
  readonly kind: TaskKind;
  /** Cron expression, event topic, or empty string for manual tasks. */
  readonly schedule_expr: string;
  /** String ID referencing the registered {@link TaskHandler}. */
  readonly handler_id: string;
  readonly enabled: boolean;
  /** Unix timestamp in milliseconds of the most recent run, or null if never run. */
  readonly last_run_at: number | null;
  /** Error message from the most recent run, or null if the last run succeeded. */
  readonly last_error: string | null;

  // ---------------------------------------------------------------------------
  // Guardrail caps (optional — null/undefined means no cap)
  // ---------------------------------------------------------------------------

  /** Maximum number of scheduled (cron/event) runs allowed per calendar day. */
  readonly max_runs_per_day: number | null;
  /** Maximum number of concurrent in-flight invocations for this task. */
  readonly max_concurrent: number | null;
  /** Maximum wall-clock duration (ms) before a run is aborted and treated as a failure. */
  readonly max_duration_ms: number | null;

  // ---------------------------------------------------------------------------
  // Guardrail bookkeeping (maintained by the scheduler)
  // ---------------------------------------------------------------------------

  /** Number of scheduled runs completed today (resets when `runs_today_date` changes). */
  readonly runs_today: number;
  /** The calendar date (ISO, YYYY-MM-DD) for which `runs_today` was last reset. */
  readonly runs_today_date: string | null;
  /** Number of consecutive failures since the last successful run. */
  readonly attempt_count: number;
  /** Unix timestamp (ms) before which the task must not be retried. */
  readonly next_attempt_at: number | null;

  // ---------------------------------------------------------------------------
  // Capability enforcement (DEV-109)
  // ---------------------------------------------------------------------------

  /** Capabilities this task requires from the host. Empty array means no restrictions. */
  readonly required_capabilities: readonly Capability[];
}

/** Transient, per-run parameters passed to a manual run. Never persisted. */
export type RunParams = Readonly<Record<string, unknown>>;

/**
 * A resolver that shells out to a CLI adapter and returns its completion.
 * Injected into the {@link import("./scheduler.ts").Scheduler} by the host so
 * `vesper-core` never imports config/path code. `opts.cli` selects a specific
 * adapter; when omitted the resolver picks the configured default.
 */
export type CompleteFn = (
  prompt: string,
  opts?: {
    readonly cli?: string;
    /**
     * Model for this call: a canonical catalog id (resolved by the host to an
     * adapter + flag value) or a raw flag value passed through verbatim.
     */
    readonly model?: string;
    /** Per-call process-timeout override (ms). */
    readonly timeoutMs?: number;
    /** Incremental assistant text (see `CompleteOptions.onText`). */
    readonly onText?: (delta: string) => void;
  },
) => Promise<CompleteResult>;

/**
 * A proactive notification a pipeline asks the host to deliver out a connected
 * messaging channel (the outbound complement to the inbound chatbot flow).
 * `channel`/`chatId` are host concerns: when omitted the host resolves the
 * configured default channel and the paired owner destination. `channel` is a
 * plain string here so `vesper-core/scheduler` stays decoupled from the
 * connections feature layer — the host validates it against the channel catalog.
 */
export interface NotifyIntent {
  readonly text: string;
  readonly channel?: string;
  readonly chatId?: string;
}

/** Why a {@link NotifyOutcome} did not deliver (`delivered === false`). */
export type NotifyFailReason = "unavailable" | "no_channel" | "no_destination" | "send_failed";

/** The result of a {@link PipelineContext.notify} call. */
export interface NotifyOutcome {
  readonly delivered: boolean;
  /** The channel id the host resolved/used, when one was chosen. */
  readonly channel?: string;
  /** Set only when `delivered` is false. */
  readonly reason?: NotifyFailReason;
}

/**
 * Resolver that delivers a pipeline notification through a connected channel.
 * Injected into the {@link import("./scheduler.ts").Scheduler} by the host (CLI
 * layer) so `vesper-core` never imports channel/registry/config code. It returns
 * an outcome and NEVER throws for a missing channel/destination — a side-channel
 * must not crash a pipeline (contrast {@link CompleteFn}, which is load-bearing).
 */
export type NotifyFn = (intent: NotifyIntent) => Promise<NotifyOutcome>;

/** Overrides for a single manual run (transient — not stored on the task). */
export interface RunOptions {
  /** Per-run CLI override (highest priority during adapter resolution). */
  readonly cli?: string;
  /**
   * Per-run model override applied to every `ctx.complete` in this run (canonical
   * catalog id or raw flag value). An explicit per-call `opts.model` wins.
   */
  readonly model?: string;
  /** Transient run parameters, surfaced as {@link PipelineContext.params}. */
  readonly params?: RunParams;
  /**
   * DISPLAY-LINEAGE ONLY: groups this run under a parent in the activity tree
   * (sets `runs.parent_run_id`). The run is still depth 0 — it keeps its task's
   * own declared capabilities and MAY spawn its own children. Used by the
   * orchestrator to launch `spawnsOwnChildren` plan tasks as sibling runs.
   */
  readonly parentRunId?: string;
}

/**
 * The result of a completed manual run, returned by
 * {@link import("./scheduler.ts").Scheduler.run}. Fields sourced from the handler
 * are `null` when the handler did not record a run.
 */
export interface RunOutcome {
  readonly taskId: string;
  /** Id of the `runs` row the handler wrote via `ctx.recordRun`, or null. */
  readonly runId: string | null;
  /** Status the handler recorded (e.g. "ok", "no_change"), or null. */
  readonly status: string | null;
  /** Summary the handler recorded, or null. */
  readonly summary: string | null;
  /** The per-run CLI override requested for this run, or null (used the default). */
  readonly cli: string | null;
  /** Wall-clock duration of the handler invocation, in milliseconds. */
  readonly durationMs: number;
}

/**
 * Describes a sub-agent a handler asks the runtime to spawn via
 * {@link PipelineContext.spawn}. The requested `capabilities` must be a subset of
 * the parent task's grant AND of the host ceiling (two-sided gate); they become
 * the child context's `required_capabilities`.
 */
export interface SubAgentDescriptor {
  /** Registered handler id to run as the child (resolved via the registry — no eval). */
  readonly handlerId: string;
  /** Human-readable label surfaced in the live trace. */
  readonly label: string;
  /** Transient params handed to the child context. */
  readonly params?: RunParams;
  /** Capabilities the child requires. Empty/omitted means none. */
  readonly capabilities?: readonly Capability[];
  /** Per-child duration cap (ms). Intersected (Math.min) with the parent's remaining budget. */
  readonly maxDurationMs?: number;
  /** Model override applied to every `ctx.complete` in the child run. */
  readonly model?: string;
}

/** Handle returned by {@link PipelineContext.spawn} for an in-flight sub-agent. */
export interface SubAgentHandle {
  /** Id of the child `runs` row (allocated up front, status `running`). */
  readonly runId: string;
  readonly handlerId: string;
  readonly label: string;
  /** Resolves with the child {@link RunOutcome}, or rejects if the child failed. */
  readonly done: Promise<RunOutcome>;
}

/**
 * The kind of a live-trace {@link ProgressEvent}. Mostly mirrors storage
 * `RunEventKind`, with one deliberate divergence: `"text"` is PUBLISH-ONLY —
 * streamed assistant deltas ride the bus to live clients but are never persisted
 * (the durable record of a completion's text is the `io` result event).
 */
export type ProgressKind = "step" | "log" | "progress" | "spawn" | "complete" | "text";

/** A single live-trace step a handler emits via {@link PipelineContext.emitProgress}. */
export interface ProgressEvent {
  readonly kind: ProgressKind;
  readonly message: string;
  /** Optional structured detail (e.g. percentage, child run id). */
  readonly data?: Record<string, unknown>;
}

/**
 * Capability-gated context handed to a pipeline handler on each invocation.
 *
 * Beyond the task metadata (`task`, `now`, `params`, `runId`, `parentRunId`) it
 * exposes side-effecting methods, each gated on a capability the task must declare:
 * - `complete` (`CLI_INVOKE`)
 * - `recordRun` (`WRITE_STORAGE`)
 * - `emitProgress` (`WRITE_STORAGE`) — persists a live-trace step and publishes it
 * - `spawn` (`SPAWN_SUBAGENT`) — runs a registered handler as an in-process child
 * - `readSignals` (`READ_STORAGE`) — returns a frozen runtime-health snapshot
 * - `notify` (`NETWORK_FETCH`) — delivers a proactive message out a connected channel
 */
export interface PipelineContext {
  readonly task: ScheduledTask;
  readonly now: Date;
  /** Transient run params (empty object for scheduled runs). */
  readonly params: RunParams;
  /** Id of this run's `runs` row, allocated up front by the scheduler. */
  readonly runId: string;
  /** Parent run id when this is a sub-agent invocation; null for top-level runs. */
  readonly parentRunId: string | null;
  /**
   * Send `prompt` through the resolved CLI adapter. Requires the task to declare
   * `CLI_INVOKE`. Resolution order: `opts.cli` -> run-override -> default.
   * `opts.model` selects a model (canonical catalog id or raw flag value);
   * `opts.timeoutMs` overrides the per-call process timeout.
   */
  complete(
    prompt: string,
    opts?: {
      readonly cli?: string;
      readonly model?: string;
      readonly timeoutMs?: number;
      readonly onText?: (delta: string) => void;
    },
  ): Promise<CompleteResult>;
  /** Write a `runs` row for this pipeline. Requires the task to declare `WRITE_STORAGE`. */
  recordRun(input: { readonly status: string; readonly summary: string }): string;
  /**
   * Persist a live-trace step and publish it on the event bus. Requires the task
   * to declare `WRITE_STORAGE`.
   */
  emitProgress(event: ProgressEvent): void;
  /**
   * Spawn a registered handler as an in-process sub-agent. Requires the task to
   * declare `SPAWN_SUBAGENT`. The descriptor's capabilities must be a subset of
   * this task's grant and of the host ceiling. Sub-agents cannot spawn
   * sub-agents (depth = 1).
   */
  spawn(descriptor: SubAgentDescriptor): SubAgentHandle;
  /**
   * Read a frozen, read-only snapshot of runtime-health signals (recent runs,
   * dead-lettered tasks, per-task last errors) over `[now - windowMs, now]`.
   * Requires the task to declare `READ_STORAGE`. The snapshot is detached from the
   * live store — a handler cannot read past its window or write through it.
   */
  readSignals(opts?: { readonly windowMs?: number }): EvolveSignals;
  /**
   * Deliver a proactive notification to the user through a connected messaging
   * channel. Requires the task to declare `NETWORK_FETCH` (the egress capability
   * `ChannelHandler.send` already requires). The channel and destination are
   * resolved by the host — `opts.channel`/`opts.chatId` override, otherwise the
   * configured default channel and the paired owner are used. A missing channel,
   * destination, or host resolver yields `{ delivered:false, reason }`; only a
   * capability violation throws.
   */
  notify(
    text: string,
    opts?: { readonly channel?: string; readonly chatId?: string },
  ): Promise<NotifyOutcome>;
}

/**
 * Context provided to a handler when a task is invoked.
 * @deprecated Use {@link PipelineContext}; retained as an alias for back-compat.
 */
export type TaskContext = PipelineContext;

/** A function invoked when a task is triggered. */
export type TaskHandler = (ctx: PipelineContext) => Promise<void> | void;

/** Input for registering a new scheduled task. */
export interface RegisterTaskInput {
  readonly id: string;
  readonly kind: TaskKind;
  /** Cron expression (for cron), event topic (for event), or "" (for manual). */
  readonly schedule_expr: string;
  /** ID of the handler to invoke, must be registered in the {@link HandlerRegistry}. */
  readonly handler_id: string;
  /** Whether the task starts enabled. Defaults to true. */
  readonly enabled?: boolean;

  // ---------------------------------------------------------------------------
  // Optional guardrail caps
  // ---------------------------------------------------------------------------

  /** Maximum scheduled runs per calendar day. No limit if omitted. */
  readonly max_runs_per_day?: number;
  /** Maximum concurrent in-flight invocations. No limit if omitted. */
  readonly max_concurrent?: number;
  /** Maximum run duration in ms. No timeout if omitted. */
  readonly max_duration_ms?: number;
  /**
   * Capabilities this task requires from the host.
   * Defaults to [] (no capabilities needed).
   * If any required capability is not in the host's granted list, the task is refused.
   */
  readonly required_capabilities?: readonly Capability[];
}

/** A dead-lettered task entry, written when a task exceeds the max retry attempts. */
export interface FailedTask {
  readonly id: string;
  readonly task_id: string;
  /** Unix timestamp (ms) of the run that caused the dead-letter. */
  readonly run_at: number;
  readonly error: string;
  readonly attempt_count: number;
}
