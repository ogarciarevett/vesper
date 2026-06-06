/**
 * The software-engineer cycle loop.
 *
 * `runCycle` drives the canonical Vesper cycle as a product feature, with one
 * inviolable rule: no change is staged without an explicit, token-gated human
 * approval, and every file write is confined to a throwaway git worktree.
 *
 *   SPEC -> PLAN -> BUILD (fan-out) -> REVIEW -> [human gate] -> TEST ->
 *   SIMPLIFY -> IMPROVE -> SHIP (stage one commit, STOP — never commit/push)
 *
 * Design (flagged deviations from the spec, all "MAY"-clause simplifications):
 * - The lead drives the thinking steps directly via `ctx.complete`; only BUILD is
 *   a spawned sub-agent fan-out, because that is the one step with real parallelism
 *   (file-disjoint tasks), per-task FS_WRITE capability scoping, and a run-tree to
 *   visualize. `RunOutcome` carries only status+summary, so threading rich step
 *   output through a sub-agent per sequential step would be fragile ceremony.
 * - One aggregate BUILD change is gated (changeId `<runId>:build`); the UI renders
 *   the per-file diff. Per-file selective staging is a follow-on.
 * - The human gate uses the coordinator's own bounded timeout so a no-show is
 *   recorded as `awaiting_review_timeout` (worktree left intact) rather than being
 *   hard-aborted by the scheduler. The worktree is removed ONLY when no change was
 *   produced (SPEC/PLAN failure); otherwise it is preserved (Hard rule 4) so the
 *   developer can commit + merge the staged branch out of band.
 */

import { isAbsolute } from "node:path";
import type { AppendEventInput, PipelineContext } from "@vesper/core";
import { type ChangeDecisionCoordinator, ChangeDecisionError } from "./changes.ts";
import { contentHash, parseUnifiedDiff } from "./diff.ts";
import { type GitRunner, gitOrThrow } from "./git.ts";
import {
  BUILD_CHILD_CAPABILITIES,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  SWE_BUILD_HANDLER_ID,
  SWE_SOURCE,
} from "./ids.ts";
import { parsePlan, parseSpec, type SpecDoc } from "./parse.ts";
import { conventionalCommitMessage, planPrompt, reviewPrompt, specPrompt } from "./prompts.ts";
import { createWorktree, removeWorktree, type Worktree } from "./worktree.ts";

/** Outcome of one BUILD sub-agent, summarised back to the lead. */
export interface RunTestResult {
  readonly passed: boolean;
  readonly summary: string;
}

/** Injected seams for {@link runCycle}. Everything that touches a process, the DB, or wall-clock is here. */
export interface CycleDeps {
  /** Git seam (prod: `makeGitRunner(runProcess)`). */
  readonly git: GitRunner;
  /** Durable `events` audit sink. */
  readonly appendEvent: (input: AppendEventInput) => string;
  /** Shared in-process gate bridging this cycle and the HTTP decision route. */
  readonly coordinator: ChangeDecisionCoordinator;
  /** Run `bun test` + `biome ci` inside the worktree (prod: a cwd-capable process call). */
  readonly runTest: (worktree: Worktree) => Promise<RunTestResult>;
  /** Resolve an auto-evolve `fix_proposal` id to its `proposedFix` seed text, or null. */
  readonly loadFixProposal?: (id: string) => string | null;
  /** Worktree base dir override (tests). Defaults to `~/.vesper/swe`. */
  readonly baseDir?: string;
  /** Human-gate timeout override (ms). */
  readonly approvalTimeoutMs?: number;
  /** Per git-call timeout (ms). */
  readonly gitTimeoutMs?: number;
}

/** What the lead records for the run. */
export interface CycleResult {
  readonly status: string;
  readonly summary: string;
}

function asString(params: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const raw = params[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

/** Resolve the SPEC seed: the `wish` param, else a loaded `fixProposalId`. */
function resolveSeed(ctx: PipelineContext, deps: CycleDeps): string | null {
  const wish = asString(ctx.params, "wish");
  if (wish !== undefined) return wish;
  const fixId = asString(ctx.params, "fixProposalId");
  if (fixId !== undefined && deps.loadFixProposal !== undefined) {
    return deps.loadFixProposal(fixId);
  }
  return null;
}

/** Resolve the human-gate timeout: explicit param/dep, else the task cap, else the default. */
function approvalTimeoutMs(ctx: PipelineContext, deps: CycleDeps): number {
  const fromParam = ctx.params.approvalTimeoutMs;
  if (typeof fromParam === "number" && fromParam > 0) return fromParam;
  if (deps.approvalTimeoutMs !== undefined && deps.approvalTimeoutMs > 0)
    return deps.approvalTimeoutMs;
  if (ctx.task.max_duration_ms !== null && ctx.task.max_duration_ms > 0)
    return ctx.task.max_duration_ms;
  return DEFAULT_APPROVAL_TIMEOUT_MS;
}

export async function runCycle(ctx: PipelineContext, deps: CycleDeps): Promise<CycleResult> {
  const gitTimeoutMs = deps.gitTimeoutMs;
  const audit = (step: string, status: string, extra?: Record<string, unknown>): void => {
    ctx.emitProgress({ kind: "step", message: `${step}: ${status}` });
    deps.appendEvent({
      source: SWE_SOURCE,
      kind: "swe_step",
      payload: { runId: ctx.runId, step, status, ...extra },
    });
  };

  // --- preconditions -------------------------------------------------------
  const repo = asString(ctx.params, "repo");
  if (repo === undefined || !isAbsolute(repo)) {
    audit("spec", "error");
    return { status: "error", summary: "params.repo must be an absolute path to a git repository" };
  }
  const seed = resolveSeed(ctx, deps);
  if (seed === null) {
    audit("spec", "error");
    return { status: "error", summary: "no `wish` or resolvable `fixProposalId` provided" };
  }

  // --- worktree ------------------------------------------------------------
  let wt: Worktree;
  try {
    wt = await createWorktree(deps.git, repo, ctx.runId, {
      ...(deps.baseDir !== undefined ? { baseDir: deps.baseDir } : {}),
      ...(gitTimeoutMs !== undefined ? { timeoutMs: gitTimeoutMs } : {}),
    });
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    audit("spec", "error", { error: msg });
    return { status: "error", summary: `worktree create failed: ${msg}` };
  }
  audit("worktree", "created", { worktree: wt.path, branch: wt.branch });

  // --- SPEC ----------------------------------------------------------------
  const specReply = await ctx.complete(specPrompt(seed));
  const specParsed = parseSpec(specReply.text);
  if (!specParsed.ok) {
    await safeRemove(deps, wt);
    audit("spec", "failed", { error: specParsed.error });
    return { status: "no_change", summary: `SPEC unparseable: ${specParsed.error}` };
  }
  const spec: SpecDoc = specParsed.value;
  audit("spec", "ok", { title: spec.title });

  // --- PLAN ----------------------------------------------------------------
  const planReply = await ctx.complete(planPrompt(spec));
  const planParsed = parsePlan(planReply.text);
  if (!planParsed.ok) {
    await safeRemove(deps, wt);
    audit("plan", "failed", { error: planParsed.error });
    return { status: "no_change", summary: `PLAN unparseable: ${planParsed.error}` };
  }
  const tasks = planParsed.value.tasks;
  audit("plan", "ok", { taskCount: tasks.length });

  // --- BUILD (fan-out) -----------------------------------------------------
  const handles = tasks.map((t) =>
    ctx.spawn({
      handlerId: SWE_BUILD_HANDLER_ID,
      label: `build:${t.id}`,
      params: {
        worktree: wt.path,
        repo,
        instruction: t.instruction,
        files: t.files,
        changeId: t.id,
      },
      capabilities: BUILD_CHILD_CAPABILITIES,
    }),
  );
  const settled = await Promise.allSettled(handles.map((h) => h.done));
  const built = settled.filter((s) => s.status === "fulfilled").length;
  if (built === 0) {
    audit("build", "failed", { taskCount: tasks.length });
    return { status: "build_failed", summary: `all ${tasks.length} BUILD tasks failed` };
  }
  audit("build", "ok", { built, failed: settled.length - built });

  // --- diff + propose the change ------------------------------------------
  const changeId = `${ctx.runId}:build`;
  await gitOrThrow(deps.git, wt.path, ["add", "-N", "."], wrap(gitTimeoutMs));
  const rawDiff = (await deps.git(wt.path, ["diff"], wrap(gitTimeoutMs))).stdout;
  const parsedDiff = parseUnifiedDiff(rawDiff);
  const files = parsedDiff.files.map((f) => f.path);
  const hash = contentHash(rawDiff);
  deps.appendEvent({
    source: SWE_SOURCE,
    kind: "swe_change_proposed",
    payload: {
      runId: ctx.runId,
      changeId,
      worktree: wt.path,
      files,
      additions: parsedDiff.additions,
      deletions: parsedDiff.deletions,
      contentHash: hash,
    },
  });
  ctx.emitProgress({
    kind: "complete",
    message: `change proposed: ${changeId}`,
    data: {
      changeId,
      swe: "change_proposed",
      files,
      additions: parsedDiff.additions,
      deletions: parsedDiff.deletions,
    },
  });

  // --- REVIEW (advisory) ---------------------------------------------------
  const reviewReply = await ctx.complete(reviewPrompt(spec, rawDiff));
  audit("review", "ok", { report: reviewReply.text.slice(0, 2000) });

  // --- human gate ----------------------------------------------------------
  let decision: { decision: "approve" | "reject"; reason?: string };
  try {
    decision = await deps.coordinator.awaitDecision(ctx.runId, changeId, {
      timeoutMs: approvalTimeoutMs(ctx, deps),
    });
  } catch (cause) {
    if (cause instanceof ChangeDecisionError && cause.reason === "timeout") {
      audit("approve", "timeout", { changeId });
      return {
        status: "awaiting_review_timeout",
        summary: `no decision for ${changeId}; worktree preserved`,
      };
    }
    const msg = cause instanceof Error ? cause.message : String(cause);
    audit("approve", "aborted", { changeId, error: msg });
    return { status: "error", summary: `gate aborted: ${msg}` };
  }

  if (decision.decision === "reject") {
    // Unstage the intent-to-add; leave working-tree edits in the throwaway worktree
    // for inspection (Hard rule 4 — never destroy). A restore + rebuild loop is a follow-on.
    await deps.git(wt.path, ["restore", "--staged", "."], wrap(gitTimeoutMs));
    deps.appendEvent({
      source: SWE_SOURCE,
      kind: "swe_change_rejected",
      payload: {
        runId: ctx.runId,
        changeId,
        files,
        ...(decision.reason ? { reason: decision.reason } : {}),
      },
    });
    ctx.emitProgress({
      kind: "complete",
      message: `change rejected: ${changeId}`,
      data: { changeId, swe: "change_rejected" },
    });
    return {
      status: "rejected",
      summary: `change ${changeId} rejected${decision.reason ? `: ${decision.reason}` : ""}`,
    };
  }

  // approve -> stage
  await gitOrThrow(deps.git, wt.path, ["add", "-A"], wrap(gitTimeoutMs));
  deps.appendEvent({
    source: SWE_SOURCE,
    kind: "swe_change_approved",
    payload: { runId: ctx.runId, changeId, files },
  });
  ctx.emitProgress({
    kind: "complete",
    message: `change approved: ${changeId}`,
    data: { changeId, swe: "change_approved" },
  });

  // --- TEST (only AFTER approval — generated code never runs before the human sees it) ---
  const test = await deps.runTest(wt);
  if (!test.passed) {
    audit("test", "failed", { summary: test.summary.slice(0, 1000) });
    return { status: "test_failed", summary: `TEST failed: ${test.summary.slice(0, 400)}` };
  }
  audit("test", "ok");

  // --- SIMPLIFY (advisory in v1) + IMPROVE ---------------------------------
  audit("simplify", "advisory");
  deps.appendEvent({
    source: SWE_SOURCE,
    kind: "swe_improve",
    payload: { runId: ctx.runId, changeId, note: spec.title },
  });
  audit("improve", "ok");

  // --- SHIP (stage one Conventional Commit; never commit / merge / push) ---
  const message = conventionalCommitMessage(spec);
  deps.appendEvent({
    source: SWE_SOURCE,
    kind: "swe_committed",
    payload: {
      runId: ctx.runId,
      changeId,
      branch: wt.branch,
      message,
      staged: true,
      committed: false,
    },
  });
  audit("ship", "staged", { branch: wt.branch });
  return {
    status: "shipped",
    summary: `staged on ${wt.branch}; commit ready: ${message}`,
  };
}

/** git timeout wrapper -> the optional `{ timeoutMs }` opts shape, omitting when undefined. */
function wrap(timeoutMs: number | undefined): { readonly timeoutMs?: number } | undefined {
  return timeoutMs !== undefined ? { timeoutMs } : undefined;
}

/** Remove the worktree, swallowing failure (cleanup must never mask the real result). */
async function safeRemove(deps: CycleDeps, wt: Worktree): Promise<void> {
  try {
    await removeWorktree(deps.git, wt, wrap(deps.gitTimeoutMs));
  } catch {
    // Best-effort cleanup; the branch + dir survive for manual inspection.
  }
}
