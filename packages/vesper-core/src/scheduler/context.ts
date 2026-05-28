import { assertCapabilities } from "../capabilities/assert.ts";
import { CLIError } from "../cli/errors.ts";
import type { Store } from "../storage/types.ts";
import type { CompleteFn, PipelineContext, RunOptions, ScheduledTask } from "./types.ts";

/**
 * Replace a run summary with size-only metadata, so raw CLI output is never
 * persisted in cleartext when redaction is enabled. The status is kept verbatim
 * (it is never sensitive); only the free-text summary is redacted.
 */
export function redactSummary(summary: string): string {
  return `[redacted: ${summary.length} chars]`;
}

/** Dependencies needed to build a {@link PipelineContext} for a single invocation. */
export interface BuildContextDeps {
  readonly task: ScheduledTask;
  readonly now: Date;
  /** Storage used by {@link PipelineContext.recordRun}. */
  readonly store: Store;
  /**
   * Resolver that shells out to a CLI adapter. Injected by the host (CLI layer)
   * so `vesper-core` stays free of config/path concerns. When absent, calling
   * {@link PipelineContext.complete} throws a clear {@link CLIError}.
   */
  readonly complete?: CompleteFn;
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
  const { task, now, store, complete, options, onRecordRun, redactSummaries } = deps;
  const params = options?.params ?? {};

  return {
    task,
    now,
    params,

    async complete(prompt, opts) {
      assertCapabilities(["CLI_INVOKE"], task.required_capabilities);
      if (complete === undefined) {
        throw new CLIError(
          "not_installed",
          "no CLI resolver is configured for this scheduler — cannot complete a prompt",
        );
      }
      const cli = opts?.cli ?? options?.cli;
      return complete(prompt, cli !== undefined ? { cli } : {});
    },

    recordRun({ status, summary }) {
      assertCapabilities(["WRITE_STORAGE"], task.required_capabilities);
      const stored = redactSummaries === true ? redactSummary(summary) : summary;
      const runId = store.recordRun({ pipeline: task.handler_id, status, summary: stored });
      onRecordRun?.({ runId, status, summary: stored });
      return runId;
    },
  };
}
