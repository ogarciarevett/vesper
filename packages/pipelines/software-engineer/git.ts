/**
 * Thin, injectable git seam for the software-engineer pipeline.
 *
 * Every git invocation uses the `git -C <dir>` form (no cwd option in
 * RunOptions) and goes through a {@link ProcessRunner} so unit tests can
 * inject a fake and no real process is ever spawned.
 */

import type { ProcessRunner } from "@vesper/core";

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * Minimal result returned by a {@link GitRunner}.
 * A subset of RunResult — `durationMs` is intentionally omitted; callers that
 * need timing should measure at a higher level.
 */
export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

// ---------------------------------------------------------------------------
// GitRunner
// ---------------------------------------------------------------------------

/**
 * A thin, injectable seam over `git`. Every call is translated to
 * `git -C <cwd> [...args]` via the underlying {@link ProcessRunner} so that
 * the working directory is a discrete argument (no shell string, no shell).
 *
 * Returns the raw result WITHOUT throwing on a nonzero exit. Callers that
 * require failure semantics should use {@link gitOrThrow}.
 */
export type GitRunner = (
  cwd: string,
  args: readonly string[],
  opts?: { readonly timeoutMs?: number },
) => Promise<GitResult>;

// ---------------------------------------------------------------------------
// GitError
// ---------------------------------------------------------------------------

/**
 * Raised by {@link gitOrThrow} when a git command exits with a nonzero code.
 *
 * Carries the full `args` array, `exitCode`, and `stderr` text so callers
 * can surface a meaningful diagnostic. The `message` is human-readable and
 * safe to log — it never contains secrets (only args and stderr).
 */
export class GitError extends Error {
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly stderr: string;

  constructor(args: readonly string[], exitCode: number, stderr: string) {
    super(`git ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`);
    this.name = "GitError";
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Wrap a {@link ProcessRunner} into a {@link GitRunner}.
 *
 * Each call becomes:
 *   `runProcess("git", ["-C", cwd, ...args], { timeoutMs })`
 */
export function makeGitRunner(run: ProcessRunner): GitRunner {
  return async (cwd, args, opts) => {
    const result = await run("git", ["-C", cwd, ...args], {
      timeoutMs: opts?.timeoutMs,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  };
}

// ---------------------------------------------------------------------------
// Convenience
// ---------------------------------------------------------------------------

/**
 * Run a git command and throw {@link GitError} if the exit code is nonzero.
 *
 * Use this for mutating commands (commit, push, worktree add/remove) where any
 * failure is an error. For read-only queries that inspect the exit code (e.g.
 * `git diff --quiet` to detect changes), call the {@link GitRunner} directly.
 */
export async function gitOrThrow(
  git: GitRunner,
  cwd: string,
  args: readonly string[],
  opts?: { readonly timeoutMs?: number },
): Promise<GitResult> {
  const result = await git(cwd, args, opts);
  if (result.exitCode !== 0) {
    throw new GitError(args, result.exitCode, result.stderr);
  }
  return result;
}
