/**
 * Worktree lifecycle helpers for the software-engineer pipeline.
 *
 * Creates and removes git worktrees for isolated BUILD sandboxes, and enforces
 * path confinement so no file write can escape the worktree root.
 *
 * Hard rule 4 (no silent rm): the branch created by {@link createWorktree} is
 * intentionally left in place when {@link removeWorktree} is called. The
 * worktree directory is removed but the branch survives as an archival record.
 */

import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { type GitRunner, gitOrThrow } from "./git.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A checked-out git worktree managed by the software-engineer pipeline. */
export interface Worktree {
  /** Absolute path to the source repository (the main worktree). */
  readonly repo: string;
  /** Absolute path to the created worktree directory. */
  readonly path: string;
  /** The branch created inside the worktree (`vesper/swe-<runId>`). */
  readonly branch: string;
  /** The pipeline run-id that owns this worktree. */
  readonly runId: string;
}

/** Options for {@link createWorktree}. */
export interface CreateWorktreeOptions {
  /**
   * Parent directory under which the worktree path is created.
   * Defaults to `~/.vesper/swe`.
   */
  readonly baseDir?: string;
  /** Passed through to the underlying git call. */
  readonly timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/**
 * Raised by worktree operations when a git command fails or a
 * path-confinement check is violated.
 */
export class WorktreeError extends Error {
  readonly reason: "escape" | "create_failed" | "remove_failed";

  constructor(reason: WorktreeError["reason"], message: string) {
    super(message);
    this.name = "WorktreeError";
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// createWorktree
// ---------------------------------------------------------------------------

/**
 * Create a git worktree for a pipeline run.
 *
 * Runs: `git -C <repo> worktree add <path> -b vesper/swe-<runId>`
 *
 * The worktree is placed at `join(baseDir, runId)` (default baseDir:
 * `~/.vesper/swe`). Throws {@link WorktreeError}(`"create_failed"`) if the git
 * command exits nonzero.
 */
export async function createWorktree(
  git: GitRunner,
  repo: string,
  runId: string,
  opts?: CreateWorktreeOptions,
): Promise<Worktree> {
  const baseDir = opts?.baseDir ?? join(homedir(), ".vesper", "swe");
  const path = join(baseDir, runId);
  const branch = `vesper/swe-${runId}`;

  try {
    await gitOrThrow(git, repo, ["worktree", "add", path, "-b", branch], {
      timeoutMs: opts?.timeoutMs,
    });
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : `worktree add failed for run ${runId}`;
    throw new WorktreeError("create_failed", msg);
  }

  return { repo, path, branch, runId };
}

// ---------------------------------------------------------------------------
// removeWorktree
// ---------------------------------------------------------------------------

/**
 * Remove a git worktree created by {@link createWorktree}.
 *
 * Runs: `git -C <repo> worktree remove <path>`
 *
 * The branch (`vesper/swe-<runId>`) is intentionally left in place —
 * Hard rule 4: destructive operations use an archival pattern, never silent
 * deletion. Throws {@link WorktreeError}(`"remove_failed"`) if the git command
 * exits nonzero.
 */
export async function removeWorktree(
  git: GitRunner,
  wt: Worktree,
  opts?: { readonly timeoutMs?: number },
): Promise<void> {
  try {
    await gitOrThrow(git, wt.repo, ["worktree", "remove", wt.path], {
      timeoutMs: opts?.timeoutMs,
    });
  } catch (cause) {
    const msg =
      cause instanceof Error ? cause.message : `worktree remove failed for path ${wt.path}`;
    throw new WorktreeError("remove_failed", msg);
  }
}

// ---------------------------------------------------------------------------
// assertInsideWorktree
// ---------------------------------------------------------------------------

/**
 * Assert that `candidate` resolves to a path inside `worktreeRoot`.
 *
 * Uses `path.resolve` — NOT `fs.realpath` — so it works for paths that do
 * not exist yet (BUILD will write them). Guards against:
 *   - `../` traversal (e.g. `../../etc/passwd`)
 *   - Absolute paths outside the root (e.g. `/etc/passwd`)
 *   - Sibling directories sharing a name prefix
 *     (`/tmp/wt/run123-evil` is NOT inside `/tmp/wt/run123`)
 *
 * Returns the resolved absolute path on success.
 * Throws {@link WorktreeError}(`"escape"`) on any violation.
 */
export function assertInsideWorktree(worktreeRoot: string, candidate: string): string {
  const root = resolve(worktreeRoot);
  const abs = resolve(root, candidate);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new WorktreeError("escape", `path escapes worktree root: ${candidate}`);
  }
  return abs;
}
