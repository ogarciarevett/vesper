/**
 * Tests for the worktree lifecycle seam (worktree.ts).
 *
 * A fake GitRunner is injected — no real git process is spawned. Covers:
 *   - createWorktree issues the correct argv and returns {repo,path,branch,runId}
 *   - branch name is vesper/swe-<runId>; path is under baseDir
 *   - default baseDir is ~/.vesper/swe
 *   - timeoutMs threads through to the runner
 *   - WorktreeError("create_failed") on git failure
 *   - removeWorktree issues `worktree remove <path>` and never touches the branch
 *   - WorktreeError("remove_failed") on git failure
 *   - assertInsideWorktree escape cases and happy cases
 */

import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import type { GitResult, GitRunner } from "./git.ts";
import { assertInsideWorktree, createWorktree, removeWorktree, WorktreeError } from "./worktree.ts";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface GitCall {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly opts: { readonly timeoutMs?: number } | undefined;
}

function makeGitFake(
  exitCode: number,
  stdout = "",
  stderr = "",
): { git: GitRunner; calls: GitCall[] } {
  const calls: GitCall[] = [];
  const git: GitRunner = async (cwd, args, opts): Promise<GitResult> => {
    calls.push({ cwd, args, opts });
    return { stdout, stderr, exitCode };
  };
  return { git, calls };
}

// ---------------------------------------------------------------------------
// createWorktree
// ---------------------------------------------------------------------------

describe("createWorktree", () => {
  test("calls git worktree add with the correct argv and returns Worktree", async () => {
    const { git, calls } = makeGitFake(0);
    const repo = "/home/user/myrepo";
    const runId = "abc123";
    const baseDir = "/tmp/vesper-test";

    const wt = await createWorktree(git, repo, runId, { baseDir });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cwd).toBe(repo);

    const wtPath = join(baseDir, runId);
    expect(calls[0]?.args).toEqual(["worktree", "add", wtPath, "-b", "vesper/swe-abc123"]);

    expect(wt.repo).toBe(repo);
    expect(wt.path).toBe(wtPath);
    expect(wt.branch).toBe("vesper/swe-abc123");
    expect(wt.runId).toBe(runId);
  });

  test("uses default baseDir ~/.vesper/swe when not provided", async () => {
    const { git, calls } = makeGitFake(0);
    const { homedir } = await import("node:os");
    const runId = "run-xyz";

    const wt = await createWorktree(git, "/repo", runId);

    const expectedPath = join(homedir(), ".vesper", "swe", runId);
    expect(calls[0]?.args[2]).toBe(expectedPath);
    expect(wt.path).toBe(expectedPath);
  });

  test("branch is always vesper/swe-<runId>", async () => {
    const { git } = makeGitFake(0);

    const wt = await createWorktree(git, "/repo", "run-007", { baseDir: "/tmp" });

    expect(wt.branch).toBe("vesper/swe-run-007");
  });

  test("threads timeoutMs to the git runner", async () => {
    const { git, calls } = makeGitFake(0);

    await createWorktree(git, "/repo", "run1", { baseDir: "/tmp", timeoutMs: 10_000 });

    expect(calls[0]?.opts?.timeoutMs).toBe(10_000);
  });

  test("throws WorktreeError('create_failed') when git exits nonzero", async () => {
    const { git } = makeGitFake(128, "", "fatal: branch already exists");

    await expect(createWorktree(git, "/repo", "run1", { baseDir: "/tmp" })).rejects.toBeInstanceOf(
      WorktreeError,
    );
  });

  test("WorktreeError has reason 'create_failed' on git failure", async () => {
    const { git } = makeGitFake(1, "", "error: cannot create worktree");

    let caught: WorktreeError | undefined;
    try {
      await createWorktree(git, "/repo", "run1", { baseDir: "/tmp" });
    } catch (e) {
      if (e instanceof WorktreeError) caught = e;
    }

    expect(caught?.reason).toBe("create_failed");
  });
});

// ---------------------------------------------------------------------------
// removeWorktree
// ---------------------------------------------------------------------------

describe("removeWorktree", () => {
  test("calls git worktree remove with the worktree path", async () => {
    const { git, calls } = makeGitFake(0);
    const wt = {
      repo: "/repo",
      path: "/tmp/vesper/run1",
      branch: "vesper/swe-run1",
      runId: "run1",
    };

    await removeWorktree(git, wt);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cwd).toBe("/repo");
    expect(calls[0]?.args).toEqual(["worktree", "remove", "/tmp/vesper/run1"]);
  });

  test("issues exactly one git call — no branch-delete command", async () => {
    const { git, calls } = makeGitFake(0);
    const wt = {
      repo: "/repo",
      path: "/tmp/vesper/run1",
      branch: "vesper/swe-run1",
      runId: "run1",
    };

    await removeWorktree(git, wt);

    expect(calls).toHaveLength(1);
    const allArgs = calls.flatMap((c) => [...c.args]);
    expect(allArgs).not.toContain("branch");
    expect(allArgs).not.toContain("-d");
    expect(allArgs).not.toContain("-D");
  });

  test("throws WorktreeError('remove_failed') when git exits nonzero", async () => {
    const { git } = makeGitFake(1, "", "error: worktree not found");
    const wt = {
      repo: "/repo",
      path: "/tmp/vesper/run1",
      branch: "vesper/swe-run1",
      runId: "run1",
    };

    let caught: WorktreeError | undefined;
    try {
      await removeWorktree(git, wt);
    } catch (e) {
      if (e instanceof WorktreeError) caught = e;
    }

    expect(caught?.reason).toBe("remove_failed");
  });

  test("threads timeoutMs to the git runner", async () => {
    const { git, calls } = makeGitFake(0);
    const wt = {
      repo: "/repo",
      path: "/tmp/vesper/run1",
      branch: "vesper/swe-run1",
      runId: "run1",
    };

    await removeWorktree(git, wt, { timeoutMs: 15_000 });

    expect(calls[0]?.opts?.timeoutMs).toBe(15_000);
  });
});

// ---------------------------------------------------------------------------
// assertInsideWorktree — happy cases
// ---------------------------------------------------------------------------

describe("assertInsideWorktree — happy cases", () => {
  const root = "/tmp/vesper-wt-test/run123";

  test("returns resolved absolute path for a relative candidate inside root", () => {
    const result = assertInsideWorktree(root, "src/x.ts");
    expect(result).toBe(resolve(root, "src/x.ts"));
  });

  test("returns resolved path for a deeply nested subdirectory", () => {
    const result = assertInsideWorktree(root, "a/b/c/deep.ts");
    expect(result).toBe(resolve(root, "a/b/c/deep.ts"));
  });

  test("returns the root itself when candidate resolves to root ('.')", () => {
    const result = assertInsideWorktree(root, ".");
    expect(result).toBe(resolve(root));
  });

  test("returns resolved path for a file directly in root", () => {
    const result = assertInsideWorktree(root, "README.md");
    expect(result).toBe(join(root, "README.md"));
  });
});

// ---------------------------------------------------------------------------
// assertInsideWorktree — escape cases
// ---------------------------------------------------------------------------

describe("assertInsideWorktree — escape cases", () => {
  const root = "/tmp/vesper-wt-test/run123";

  test("throws WorktreeError('escape') for '../' traversal", () => {
    let caught: WorktreeError | undefined;
    try {
      assertInsideWorktree(root, "../../etc/passwd");
    } catch (e) {
      if (e instanceof WorktreeError) caught = e;
    }
    expect(caught).toBeInstanceOf(WorktreeError);
    expect(caught?.reason).toBe("escape");
  });

  test("throws WorktreeError('escape') for an absolute path escaping root", () => {
    let caught: WorktreeError | undefined;
    try {
      assertInsideWorktree(root, "/etc/passwd");
    } catch (e) {
      if (e instanceof WorktreeError) caught = e;
    }
    expect(caught).toBeInstanceOf(WorktreeError);
    expect(caught?.reason).toBe("escape");
  });

  test("throws WorktreeError('escape') for an absolute path that is a parent of root", () => {
    let caught: WorktreeError | undefined;
    try {
      assertInsideWorktree(root, "/tmp");
    } catch (e) {
      if (e instanceof WorktreeError) caught = e;
    }
    expect(caught).toBeInstanceOf(WorktreeError);
    expect(caught?.reason).toBe("escape");
  });

  test("throws WorktreeError('escape') for a sibling sharing a name prefix (prefix-attack)", () => {
    // root = /tmp/vesper-wt-test/run123
    // sibling = /tmp/vesper-wt-test/run123-evil  (shares the prefix, not inside)
    const sibling = `${root}-evil`;
    let caught: WorktreeError | undefined;
    try {
      assertInsideWorktree(root, sibling);
    } catch (e) {
      if (e instanceof WorktreeError) caught = e;
    }
    expect(caught).toBeInstanceOf(WorktreeError);
    expect(caught?.reason).toBe("escape");
  });

  test("throws WorktreeError('escape') for a single-step parent traversal", () => {
    let caught: WorktreeError | undefined;
    try {
      assertInsideWorktree(root, "../run456");
    } catch (e) {
      if (e instanceof WorktreeError) caught = e;
    }
    expect(caught).toBeInstanceOf(WorktreeError);
    expect(caught?.reason).toBe("escape");
  });
});
