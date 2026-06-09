import { gatherSignals } from "../auto-evolve/gather.ts";
import { assertCapabilities } from "../capabilities/assert.ts";
import type { Capability } from "../capabilities/index.ts";
import { CLIError } from "../cli/errors.ts";
import type { CompleteUsage } from "../cli/types.ts";
import type { Store } from "../storage/types.ts";
import { SchedulerError } from "./errors.ts";
import type { EventBus } from "./events.ts";
import { RUN_EVENT } from "./events.ts";
import type { TaskPersistence } from "./persistence.ts";
import type { HandlerRegistry } from "./registry.ts";
import type {
  CompleteFn,
  NotifyFn,
  PipelineContext,
  RunOptions,
  ScheduledTask,
  SubAgentDescriptor,
  SubAgentHandle,
} from "./types.ts";

/** Default look-back window for {@link PipelineContext.readSignals} (24 hours). */
const DEFAULT_SIGNAL_WINDOW_MS = 24 * 60 * 60 * 1_000;

/**
 * Replace a run summary with size-only metadata, so raw CLI output is never
 * persisted in cleartext when redaction is enabled. The status is kept verbatim
 * (it is never sensitive); only the free-text summary is redacted.
 */
export function redactSummary(summary: string): string {
  return `[redacted: ${summary.length} chars]`;
}

/**
 * Context-window size (tokens) for a model id, mirroring the statusline HUD: a "1m"
 * variant tag selects the 1,000,000-token window, otherwise the standard 200,000.
 * Used to turn a completion's reported usage into a fill percentage downstream.
 */
export function contextWindowFor(model: string | null): number {
  return model?.toLowerCase().includes("1m") ? 1_000_000 : 200_000;
}

/** Dependencies needed to build a {@link PipelineContext} for a single invocation. */
export interface BuildContextDeps {
  readonly task: ScheduledTask;
  readonly now: Date;
  /** Id of this run's `runs` row — allocated up front by the scheduler via `startRun`. */
  readonly runId: string;
  /** Parent run id for a sub-agent invocation; null for a top-level run. */
  readonly parentRunId: string | null;
  /** Storage used by {@link PipelineContext.recordRun}/`emitProgress`/`readSignals`. */
  readonly store: Store;
  /**
   * Task persistence used by {@link PipelineContext.readSignals} to read
   * dead-lettered tasks + per-task last errors. When absent, `readSignals` reports
   * only run-derived signals (failed-task/last-error sections read empty).
   */
  readonly taskPersistence?: TaskPersistence;
  /**
   * Resolver that shells out to a CLI adapter. Injected by the host (CLI layer)
   * so `vesper-core` stays free of config/path concerns. When absent, calling
   * {@link PipelineContext.complete} throws a clear {@link CLIError}.
   */
  readonly complete?: CompleteFn;
  /**
   * Resolver that delivers a pipeline notification out a connected channel.
   * Injected by the host. When absent, `ctx.notify` resolves to
   * `{ delivered:false, reason:"unavailable" }` — a missing side-channel must not
   * crash a pipeline.
   */
  readonly notify?: NotifyFn;
  /** Per-run overrides (manual run): transient CLI override + params. */
  readonly options?: RunOptions;
  /**
   * Invoked synchronously after each `ctx.recordRun`, so the scheduler can build a
   * {@link import("./types.ts").RunOutcome} without the handler returning anything.
   * Reports the summary AS STORED (already redacted when `redactSummaries` is set).
   */
  readonly onRecordRun?: (record: { runId: string; status: string; summary: string }) => void;
  /** When true, the run summary is stored as size-only metadata (see {@link redactSummary}). */
  readonly redactSummaries?: boolean;
  /** Event bus used by `emitProgress` to publish the live-trace step. Optional. */
  readonly events?: EventBus;
  /** Handler registry — handed through to the spawn fn (see {@link import("./subagent.ts")}). */
  readonly registry?: HandlerRegistry;
  /** Host capability ceiling — the absolute upper bound for any spawned sub-agent. */
  readonly grants?: readonly Capability[];
  /** This task's grant subset — the upper bound a spawned descriptor is checked against. */
  readonly parentTaskCapabilities?: readonly Capability[];
  /**
   * Spawn implementation injected by the scheduler/sub-agent layer. Kept as a
   * function (not an import) so `context.ts` has no dependency cycle on
   * `subagent.ts`. When absent, `ctx.spawn` throws `spawn_unavailable`.
   */
  readonly spawn?: (descriptor: SubAgentDescriptor, parent: PipelineContext) => SubAgentHandle;
  /** Cap on the number of sub-agents one parent may spawn. */
  readonly maxFanout?: number;
}

/**
 * Build the capability-gated context handed to a pipeline handler on each
 * invocation.
 *
 * Each side-effecting method asserts the matching capability is *declared* in
 * the task's `required_capabilities` BEFORE acting (the DEV-109 check applied at
 * the handler-context boundary). This is the self-declaration gate; the
 * scheduler separately enforces that declared capabilities are host-granted.
 *
 * - `complete` requires `CLI_INVOKE`.
 * - `recordRun` requires `WRITE_STORAGE`.
 *
 * CLI resolution order for `complete`: explicit `opts.cli` -> run-override
 * (`options.cli`) -> the injected resolver's configured default.
 */
export function buildPipelineContext(deps: BuildContextDeps): PipelineContext {
  const { task, now, runId, parentRunId, store, complete, options, onRecordRun, redactSummaries } =
    deps;
  const params = options?.params ?? {};

  // Record the latest context-window fill from a completion's usage. Best-effort:
  // observability must NEVER break a completion. Mirrors emitProgress's
  // persist-then-publish-with-id so a live `usage` frame de-dupes against its
  // backfilled twin on the client. "Used" = the prompt that was sent (input + cache
  // tokens), matching the statusline HUD — output tokens are not part of the window.
  const recordContextUsage = (usage: CompleteUsage | undefined): void => {
    if (usage === undefined) return;
    try {
      const usedTokens =
        usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0);
      const model = usage.model ?? null;
      // Prefer the CLI's exact window when it reports one; else fall back to the
      // model-name heuristic.
      const limit = usage.contextWindow ?? contextWindowFor(model);
      store.recordRunContext({ runId, usedTokens, limit, model });
      const payload: Record<string, unknown> = { usedTokens, limit, model };
      const eventId = store.appendRunEvent({ runId, kind: "usage", payload });
      deps.events?.emit(RUN_EVENT, {
        id: eventId,
        ts: Date.now(),
        runId,
        parentRunId,
        kind: "usage",
        message: `context ${usedTokens}/${limit}`,
        data: payload,
      });
    } catch {
      // best-effort: a context-capture failure must not affect the completion.
    }
  };

  // Built first so `spawn` can hand the parent context to the injected spawn fn.
  const self: PipelineContext = {
    task,
    now,
    params,
    runId,
    parentRunId,

    async complete(prompt, opts) {
      assertCapabilities(["CLI_INVOKE"], task.required_capabilities);
      if (complete === undefined) {
        throw new CLIError(
          "not_installed",
          "no CLI resolver is configured for this scheduler — cannot complete a prompt",
        );
      }
      const cli = opts?.cli ?? options?.cli;
      const result = await complete(prompt, {
        ...(cli !== undefined ? { cli } : {}),
        ...(opts?.model !== undefined ? { model: opts.model } : {}),
        ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts?.onText !== undefined ? { onText: opts.onText } : {}),
      });
      recordContextUsage(result.usage);
      return result;
    },

    recordRun({ status, summary }) {
      assertCapabilities(["WRITE_STORAGE"], task.required_capabilities);
      const stored = redactSummaries === true ? redactSummary(summary) : summary;
      // The run row already exists (startRun, status 'running'); transition it to
      // terminal here instead of inserting a fresh row. The id is the up-front runId.
      store.finishRun({ runId, status, summary: stored });
      onRecordRun?.({ runId, status, summary: stored });
      return runId;
    },

    emitProgress(event) {
      assertCapabilities(["WRITE_STORAGE"], task.required_capabilities);
      const payload: Record<string, unknown> = { message: event.message };
      if (event.data !== undefined) payload.data = event.data;
      // Ride the persisted row's id + ts on the bus payload so a live frame
      // de-dupes against its backfilled twin (same id) on the client.
      const eventId = store.appendRunEvent({ runId, kind: event.kind, payload });
      deps.events?.emit(RUN_EVENT, {
        id: eventId,
        ts: Date.now(),
        runId,
        parentRunId,
        kind: event.kind,
        message: event.message,
        ...(event.data !== undefined ? { data: event.data } : {}),
      });
    },

    spawn(descriptor) {
      assertCapabilities(["SPAWN_SUBAGENT"], task.required_capabilities);
      if (deps.spawn === undefined) {
        throw new SchedulerError(
          "spawn_unavailable",
          "this context was built without a spawn implementation (no registry/events wired)",
        );
      }
      return deps.spawn(descriptor, self);
    },

    readSignals(opts) {
      assertCapabilities(["READ_STORAGE"], task.required_capabilities);
      const windowMs = opts?.windowMs ?? DEFAULT_SIGNAL_WINDOW_MS;
      const sinceMs = now.getTime() - windowMs;
      const persistence = deps.taskPersistence;
      return gatherSignals(
        {
          listRuns: (options) => store.listRuns(options),
          listFailedTasks: () => persistence?.listFailedTasks() ?? [],
          listTasks: () => persistence?.list() ?? [],
        },
        { sinceMs },
      );
    },

    async notify(text, opts) {
      assertCapabilities(["NETWORK_FETCH"], task.required_capabilities);
      // A missing resolver is graceful: a notification is a side-channel, not the
      // pipeline's reason to exist (contrast `complete`, which throws when unset).
      if (deps.notify === undefined) {
        return { delivered: false, reason: "unavailable" };
      }
      return deps.notify({
        text,
        ...(opts?.channel !== undefined ? { channel: opts.channel } : {}),
        ...(opts?.chatId !== undefined ? { chatId: opts.chatId } : {}),
      });
    },
  };

  return self;
}
