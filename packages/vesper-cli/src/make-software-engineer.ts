/**
 * Host wiring for the software-engineer pipeline's UI surface.
 *
 * The daemon owns ONE {@link ChangeDecisionCoordinator}: the running cycle blocks
 * on it at the human-approval gate, and the UI decision route resolves it. This
 * module builds the `softwareEngineer` provider the UI server expects:
 *
 * - `loadDiff` finds the run's `swe_change_proposed` audit row (which carries the
 *   worktree path), runs a read-only `git -C <worktree> diff [--staged]`, and parses
 *   it into the GitHub-PR-style structured diff the client renders.
 * - `decide` delivers a human approve/reject into the blocked cycle via the shared
 *   coordinator, returning whether a waiter was actually unblocked.
 */

import { runProcess, type Store } from "@vesper/core";
import {
  type ChangeDecision,
  type ChangeDecisionCoordinator,
  makeGitRunner,
  parseUnifiedDiff,
  SWE_SOURCE,
} from "@vesper/pipelines";
import type { SweDiffView } from "@vesper/ui";

/** Read-only git timeout for the diff route (30s). */
const DIFF_TIMEOUT_MS = 30_000;

export interface SoftwareEngineerSurfaceDeps {
  readonly coordinator: ChangeDecisionCoordinator;
  readonly store: Store;
}

export interface SoftwareEngineerSurface {
  loadDiff(
    runId: string,
    opts: { readonly changeId?: string; readonly staged?: boolean },
  ): Promise<SweDiffView | null>;
  decide(runId: string, changeId: string, decision: ChangeDecision): boolean;
}

export function makeSoftwareEngineerSurface(
  deps: SoftwareEngineerSurfaceDeps,
): SoftwareEngineerSurface {
  const git = makeGitRunner(runProcess);

  return {
    async loadDiff(runId, opts) {
      // The proposed-change audit row carries the worktree path; pick the newest match.
      const row = deps.store
        .listEvents({ source: SWE_SOURCE, kind: "swe_change_proposed" })
        .filter(
          (r) =>
            r.payload.runId === runId &&
            (opts.changeId === undefined || r.payload.changeId === opts.changeId),
        )
        .sort((a, b) => b.ts - a.ts)[0];
      if (row === undefined) return null;

      const worktree = row.payload.worktree;
      if (typeof worktree !== "string" || worktree.length === 0) return null;
      const changeId =
        typeof row.payload.changeId === "string" ? row.payload.changeId : `${runId}:build`;

      const staged = opts.staged === true;
      const result = await git(worktree, staged ? ["diff", "--staged"] : ["diff"], {
        timeoutMs: DIFF_TIMEOUT_MS,
      });
      const parsed = parseUnifiedDiff(result.stdout);
      return {
        runId,
        changeId,
        staged,
        files: parsed.files,
        additions: parsed.additions,
        deletions: parsed.deletions,
        fileCount: parsed.fileCount,
      };
    },

    decide(runId, changeId, decision) {
      return deps.coordinator.resolve(runId, changeId, decision);
    },
  };
}
