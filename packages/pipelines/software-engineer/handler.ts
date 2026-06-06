/**
 * The software-engineer pipeline handlers.
 *
 * - The LEAD handler (`software-engineer`) drives the full visualized, human-gated
 *   cycle via {@link runCycle}.
 * - The BUILD sub-agent handler (`swe:build`) is spawned once per file-disjoint
 *   planned task; it asks the CLI brain for the file contents and writes them into
 *   the worktree, confined by {@link assertInsideWorktree}.
 *
 * Both are pure factories over injected seams so the unit suite shells out to
 * nothing. The production seams (git, store, process, fs) live in `defaults.ts`.
 */

import type { AppendEventInput, RegisterTaskInput, TaskHandler } from "@vesper/core";
import { type CycleDeps, runCycle } from "./cycle.ts";
import { LEAD_CAPABILITIES, SOFTWARE_ENGINEER_HANDLER_ID, SWE_BUILD_HANDLER_ID } from "./ids.ts";
import { buildPrompt, parseBuildOutput } from "./prompts.ts";
import { assertInsideWorktree } from "./worktree.ts";

// ---------------------------------------------------------------------------
// BUILD sub-agent
// ---------------------------------------------------------------------------

/** Injected seams for the BUILD sub-agent handler. */
export interface SweBuildDeps {
  /** Write `contents` to an absolute path (prod: mkdir -p + write). */
  readonly writeFile: (absPath: string, contents: string) => Promise<void>;
  /** Optional durable audit sink for per-task build events. */
  readonly appendEvent?: (input: AppendEventInput) => string;
}

function reqString(params: Readonly<Record<string, unknown>>, key: string): string {
  const raw = params[key];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(`build sub-agent missing string param "${key}"`);
  }
  return raw;
}

function reqStringArray(params: Readonly<Record<string, unknown>>, key: string): readonly string[] {
  const raw = params[key];
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string")) {
    throw new Error(`build sub-agent missing string[] param "${key}"`);
  }
  return raw as readonly string[];
}

/**
 * Build the BUILD sub-agent handler. It completes the build prompt, parses the
 * fenced file list, and writes each file into the worktree. A parse failure or a
 * path that escapes the worktree THROWS — the lead's `Promise.allSettled` records
 * that one task as failed without harming its file-disjoint siblings.
 */
export function createSweBuildHandler(deps: SweBuildDeps): TaskHandler {
  return async (ctx) => {
    const worktree = reqString(ctx.params, "worktree");
    const instruction = reqString(ctx.params, "instruction");
    const files = reqStringArray(ctx.params, "files");

    ctx.emitProgress({ kind: "step", message: `build: ${files.join(", ")}` });

    const reply = await ctx.complete(buildPrompt(instruction, files));
    const parsed = parseBuildOutput(reply.text);
    if (!parsed.ok) {
      // THROW (do not recordRun) so the scheduler finalizes the child row as error
      // exactly once and the lead counts this task failed.
      throw new Error(`BUILD output unparseable: ${parsed.error}`);
    }

    let written = 0;
    for (const f of parsed.value) {
      const abs = assertInsideWorktree(worktree, f.path);
      await deps.writeFile(abs, f.contents);
      written += 1;
    }
    ctx.recordRun({ status: "ok", summary: `wrote ${written} file(s)` });
  };
}

// ---------------------------------------------------------------------------
// LEAD handler
// ---------------------------------------------------------------------------

/**
 * Build the lead `software-engineer` handler over its cycle seams. The shared
 * {@link CycleDeps.coordinator} MUST be the same instance the UI decision route
 * resolves, so this is always constructed at daemon-wiring time (no standalone
 * default — unlike a self-contained pipeline such as `selftest`).
 */
export function createSoftwareEngineerHandler(deps: CycleDeps): TaskHandler {
  return async (ctx) => {
    const result = await runCycle(ctx, deps);
    ctx.recordRun(result);
  };
}

/**
 * Manual task wiring for the lead. No `max_duration_ms` is set: the human-approval
 * gate owns the bound (the coordinator's own timeout records `awaiting_review_timeout`
 * gracefully), rather than the scheduler hard-aborting a run that is waiting on a
 * person. The capability set is the full lead superset so the host ceiling
 * (`grantedCapabilities()`) covers the spawn-only BUILD child.
 */
export const softwareEngineerTaskInput: RegisterTaskInput = {
  id: SOFTWARE_ENGINEER_HANDLER_ID,
  kind: "manual",
  schedule_expr: "",
  handler_id: SOFTWARE_ENGINEER_HANDLER_ID,
  required_capabilities: LEAD_CAPABILITIES,
};

export { SOFTWARE_ENGINEER_HANDLER_ID, SWE_BUILD_HANDLER_ID };
