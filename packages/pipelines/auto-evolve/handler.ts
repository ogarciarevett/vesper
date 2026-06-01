/**
 * The `auto-evolve` pipeline — scheduled reflect -> propose -> gated-additive skill
 * acquisition. The runtime watches its OWN health: it gathers usage + error signals
 * from storage (`ctx.readSignals`, READ_STORAGE), drives the user's authenticated
 * CLI as a thinking model to reflect on them (`ctx.complete`, CLI_INVOKE — Hard rule
 * 12, no provider SDK), and writes the result to the `events` table (WRITE_STORAGE):
 * one `report`, one `skill_proposal` per recommended skill, one `fix_proposal` per
 * error fix.
 *
 * SAFETY (non-negotiable):
 * - It NEVER auto-applies code changes from error logs — those are `fix_proposal`
 *   events for human review (the software-engineer pipeline owns applying them). The
 *   handler writes ZERO files.
 * - The ONLY thing it may auto-apply is ADDITIVE skill acquisition via
 *   `bunx skills add <name> --yes`, and ONLY when (a) the task declares the new
 *   PROCESS_RUN capability, (b) the run is in apply-mode (`acquire=true`; the DEFAULT
 *   is dry-run), and (c) the proposed name passes {@link isAllowedSkillName}. The name
 *   is passed as a discrete `args[]` element (no shell string); untrusted DB text
 *   never reaches a process invocation.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import {
  type AppendEventInput,
  buildReflectPrompt,
  type EvolveReport,
  isAllowedSkillName,
  openStore,
  type ProcessRunner,
  parseEvolveReport,
  type RegisterTaskInput,
  runProcess,
  type TaskHandler,
} from "@vesper/core";

/** Allowlisted handler id referenced by the `auto-evolve` task. */
export const AUTO_EVOLVE_HANDLER_ID = "auto-evolve";

/** Default look-back window for the gather step (24h), overridable via `windowMs` param. */
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1_000;

/** Timeout for a single `bunx skills add` acquisition (60s). */
const ACQUIRE_TIMEOUT_MS = 60_000;

/** Cap on skill acquisitions per run, so one reflection reply cannot trigger unbounded `bunx`. */
const MAX_ACQUIRE_PER_RUN = 5;

/** Injected seams so the handler is unit-testable without a real DB or shell-out. */
export interface EvolveHandlerDeps {
  /** Append an audit/proposal row to the `events` table. */
  readonly appendEvent: (input: AppendEventInput) => string;
  /** The shell-out seam used (only in apply-mode) to run `bunx skills add`. */
  readonly runProcess: ProcessRunner;
}

/** Read a boolean-ish param (`true`/boolean true). */
function isAcquireMode(params: Readonly<Record<string, unknown>>): boolean {
  return params.acquire === true || params.acquire === "true";
}

/** Read the optional positive-integer window override (ms). */
function windowMs(params: Readonly<Record<string, unknown>>): number {
  const raw = params.windowMs;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_WINDOW_MS;
}

/** Append the report + one event per proposal. Returns the report summary. */
function writeProposals(
  deps: EvolveHandlerDeps,
  report: EvolveReport,
  signalCounts: Record<string, number>,
): void {
  deps.appendEvent({
    source: "auto-evolve",
    kind: "report",
    payload: { summary: report.summary, signalCounts },
  });
  for (const proposal of report.skillProposals) {
    deps.appendEvent({
      source: "auto-evolve",
      kind: "skill_proposal",
      payload: { name: proposal.name, reason: proposal.reason },
    });
  }
  for (const fix of report.fixProposals) {
    deps.appendEvent({
      source: "auto-evolve",
      kind: "fix_proposal",
      payload: { signature: fix.signature, rootCause: fix.rootCause, proposedFix: fix.proposedFix },
    });
  }
}

/**
 * Acquire the proposed skills in apply-mode. Each name MUST pass
 * {@link isAllowedSkillName}; a failing name is dropped with an audit note and NEVER
 * reaches the process runner. The validated name is passed as a discrete `args[]`
 * element (Bun.spawn array form — no shell). On exit 0 a `skill_acquired` event is
 * appended (additive: `skills add` symlinks/copies a skill; the skill is not executed).
 */
async function acquireSkills(deps: EvolveHandlerDeps, report: EvolveReport): Promise<void> {
  const seen = new Set<string>();
  let runs = 0;
  for (const proposal of report.skillProposals) {
    if (runs >= MAX_ACQUIRE_PER_RUN) break;
    // De-dupe by name so a repeated recommendation does not re-invoke bunx.
    if (seen.has(proposal.name)) continue;
    seen.add(proposal.name);
    if (!isAllowedSkillName(proposal.name)) {
      deps.appendEvent({
        source: "auto-evolve",
        kind: "acquire_skipped",
        payload: { name: String(proposal.name).slice(0, 80), reason: "name failed validation" },
      });
      continue;
    }
    runs += 1;
    const result = await deps.runProcess("bunx", ["skills", "add", proposal.name, "--yes"], {
      timeoutMs: ACQUIRE_TIMEOUT_MS,
    });
    if (result.exitCode === 0) {
      deps.appendEvent({
        source: "auto-evolve",
        kind: "skill_acquired",
        payload: { name: proposal.name },
      });
    } else {
      deps.appendEvent({
        source: "auto-evolve",
        kind: "acquire_failed",
        payload: { name: proposal.name, exitCode: result.exitCode },
      });
    }
  }
}

/**
 * Build the `auto-evolve` handler with injected write + process seams.
 *
 * Stages: GATHER (readSignals) -> REFLECT (complete) -> RECORD (+ optional ACQUIRE).
 * A parse failure is FAIL-CLOSED: the run is recorded `no_change`, nothing is written
 * or acquired, and no error is thrown to the scheduler.
 */
export function createAutoEvolveHandler(deps: EvolveHandlerDeps): TaskHandler {
  return async (ctx) => {
    // GATHER (READ_STORAGE asserted inside readSignals).
    const signals = ctx.readSignals({ windowMs: windowMs(ctx.params) });
    ctx.emitProgress({ kind: "step", message: "gathered runtime signals" });

    // REFLECT (CLI_INVOKE asserted inside complete) — the digest only, framed untrusted.
    const reply = await ctx.complete(buildReflectPrompt(signals.digest));
    const parsed = parseEvolveReport(reply.text);

    // FAIL-CLOSED: a malformed reply records no_change and writes/acquires nothing.
    if (!parsed.ok) {
      ctx.recordRun({ status: "no_change", summary: `reflection unparseable: ${parsed.error}` });
      return;
    }

    const signalCounts = {
      runs: signals.runs.length,
      errorPipelines: signals.rollups.filter((r) => r.errors > 0).length,
      failedTasks: signals.failedTasks.length,
      taskErrors: signals.taskErrors.length,
    };

    // RECORD: report + proposals (WRITE_STORAGE — these are the durable artifacts).
    writeProposals(deps, parsed.report, signalCounts);

    // ACQUIRE (opt-in): only in apply-mode AND only when the task declares PROCESS_RUN.
    // A task can only HOLD PROCESS_RUN if the host ceiling granted it, so this check is
    // the effective gate. If apply-mode is requested on a proposal-only task, DEGRADE
    // gracefully: the proposals above are already the durable output — record a skip
    // note and finish 'ok' rather than throwing AFTER the writes (which would strand the
    // proposals under an 'error' run row).
    if (isAcquireMode(ctx.params)) {
      if (ctx.task.required_capabilities.includes("PROCESS_RUN")) {
        await acquireSkills(deps, parsed.report);
      } else {
        deps.appendEvent({
          source: "auto-evolve",
          kind: "acquire_skipped",
          payload: { reason: "apply-mode requested but PROCESS_RUN not declared — proposals only" },
        });
      }
    }

    ctx.recordRun({
      status: "ok",
      summary: `auto-evolve: ${parsed.report.skillProposals.length} skill + ${parsed.report.fixProposals.length} fix proposals`,
    });
  };
}

/**
 * Production seams for the default-registered handler: append events through a
 * freshly-opened store (closed after each write) and shell out via the default
 * {@link ProcessRunner}. `openStore`/`runProcess` are import-time inert — they open
 * nothing until called — so the pure unit suite (which builds via
 * {@link createAutoEvolveHandler}) never touches the filesystem.
 */
const defaultDeps: EvolveHandlerDeps = {
  appendEvent: (input) => {
    const store = openStore(join(homedir(), ".vesper", "vesper.db"));
    try {
      return store.appendEvent(input);
    } finally {
      store.close();
    }
  },
  runProcess,
};

/**
 * The default `auto-evolve` handler used by the static pipeline registry. It opens
 * the runtime store lazily (per write) to append events and uses the real
 * `runProcess` seam for acquisition. Acquisition still cannot run unless the task is
 * given PROCESS_RUN and the run is in apply-mode — both off by default.
 */
export const autoEvolveHandler: TaskHandler = createAutoEvolveHandler(defaultDeps);

/**
 * Cron task wiring for `auto-evolve`. Opt-in (`enabled: false`) and bounded: daily at
 * 03:00 local, `max_runs_per_day: 1`, `max_duration_ms: 300_000`. The DEFAULT
 * capability set is PROPOSAL-ONLY (no PROCESS_RUN), so the out-of-the-box build
 * cannot shell out. Enabling acquisition requires widening the declared set
 * (PROCESS_RUN) in addition to passing `acquire=true`.
 */
export const autoEvolveTaskInput: RegisterTaskInput = {
  id: "auto-evolve",
  kind: "cron",
  schedule_expr: "0 3 * * *",
  handler_id: AUTO_EVOLVE_HANDLER_ID,
  enabled: false,
  max_runs_per_day: 1,
  max_duration_ms: 300_000,
  required_capabilities: ["READ_STORAGE", "CLI_INVOKE", "WRITE_STORAGE"],
};
