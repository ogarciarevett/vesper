/**
 * Tests for the git seam (git.ts).
 *
 * Nothing shells out — all git invocations go through a fake ProcessRunner
 * that captures calls and returns a configured result. The suite verifies:
 *   - makeGitRunner builds exact `["-C", cwd, ...args]` argv
 *   - timeoutMs is threaded through; absence is preserved as undefined
 *   - raw result is returned without throwing on nonzero exit
 *   - gitOrThrow returns on exit 0 and throws GitError on nonzero
 *   - GitError carries .exitCode, .stderr, .args, and a readable message
 */

import { describe, expect, test } from "bun:test";
import type { ProcessRunner, RunResult } from "@vesper/core";
import { GitError, gitOrThrow, makeGitRunner } from "./git.ts";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface ProcCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs: number | undefined;
}

function makeRunner(
  exitCode: number,
  stdout = "",
  stderr = "",
): { run: ProcessRunner; calls: ProcCall[] } {
  const calls: ProcCall[] = [];
  const run: ProcessRunner = async (command, args, opts): Promise<RunResult> => {
    calls.push({ command, args, timeoutMs: opts?.timeoutMs });
    return { stdout, stderr, exitCode, durationMs: 1 };
  };
  return { run, calls };
}

// ---------------------------------------------------------------------------
// makeGitRunner — argv construction
// ---------------------------------------------------------------------------

describe("makeGitRunner — argv construction", () => {
  test("calls process runner with 'git' and [-C, cwd] prefix", async () => {
    const { run, calls } = makeRunner(0, "on branch main", "");
    const git = makeGitRunner(run);

    await git("/repo/path", ["status", "--short"]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("git");
    expect(calls[0]?.args).toEqual(["-C", "/repo/path", "status", "--short"]);
  });

  test("builds exact argv: ['-C', cwd, ...args] with multiple args", async () => {
    const { run, calls } = makeRunner(0);
    const git = makeGitRunner(run);

    await git("/my/repo", ["worktree", "add", "/other/path", "-b", "feature"]);

    expect(calls[0]?.args).toEqual([
      "-C",
      "/my/repo",
      "worktree",
      "add",
      "/other/path",
      "-b",
      "feature",
    ]);
  });

  test("threads timeoutMs through to RunOptions", async () => {
    const { run, calls } = makeRunner(0);
    const git = makeGitRunner(run);

    await git("/repo", ["log", "--oneline"], { timeoutMs: 5_000 });

    expect(calls[0]?.timeoutMs).toBe(5_000);
  });

  test("passes undefined timeoutMs when no opts provided", async () => {
    const { run, calls } = makeRunner(0);
    const git = makeGitRunner(run);

    await git("/repo", ["status"]);

    expect(calls[0]?.timeoutMs).toBeUndefined();
  });

  test("returns raw result without throwing on nonzero exit", async () => {
    const { run } = makeRunner(128, "", "fatal: not a git repository");
    const git = makeGitRunner(run);

    const result = await git("/not-a-repo", ["status"]);

    expect(result.exitCode).toBe(128);
    expect(result.stderr).toBe("fatal: not a git repository");
  });

  test("returns stdout on success", async () => {
    const { run } = makeRunner(0, "my-branch", "");
    const git = makeGitRunner(run);

    const result = await git("/repo", ["rev-parse", "--abbrev-ref", "HEAD"]);

    expect(result.stdout).toBe("my-branch");
    expect(result.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// gitOrThrow
// ---------------------------------------------------------------------------

describe("gitOrThrow", () => {
  test("returns the result on exit 0", async () => {
    const { run } = makeRunner(0, "branch output", "");
    const git = makeGitRunner(run);

    const result = await gitOrThrow(git, "/repo", ["branch", "--show-current"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("branch output");
  });

  test("throws GitError on nonzero exit", async () => {
    const { run } = makeRunner(128, "", "fatal: not a git repository");
    const git = makeGitRunner(run);

    await expect(gitOrThrow(git, "/repo", ["status"])).rejects.toBeInstanceOf(GitError);
  });

  test("GitError carries exitCode, stderr, and args", async () => {
    const { run } = makeRunner(128, "", "fatal: no such branch");
    const git = makeGitRunner(run);

    let caught: GitError | undefined;
    try {
      await gitOrThrow(git, "/repo", ["checkout", "missing-branch"]);
    } catch (e) {
      if (e instanceof GitError) caught = e;
    }

    expect(caught).toBeDefined();
    expect(caught?.exitCode).toBe(128);
    expect(caught?.stderr).toBe("fatal: no such branch");
    expect(caught?.args).toEqual(["checkout", "missing-branch"]);
  });

  test("GitError message is human-readable and includes the exit code", async () => {
    const { run } = makeRunner(1, "", "error: something went wrong");
    const git = makeGitRunner(run);

    let caught: GitError | undefined;
    try {
      await gitOrThrow(git, "/repo", ["push"]);
    } catch (e) {
      if (e instanceof GitError) caught = e;
    }

    expect(caught?.message).toContain("push");
    expect(caught?.message).toContain("exit 1");
    expect(caught?.message).toContain("error: something went wrong");
  });

  test("threads timeoutMs into the underlying runner via gitOrThrow", async () => {
    const { run, calls } = makeRunner(0);
    const git = makeGitRunner(run);

    await gitOrThrow(git, "/repo", ["diff", "--stat"], { timeoutMs: 8_000 });

    expect(calls[0]?.timeoutMs).toBe(8_000);
  });
});
