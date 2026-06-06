/**
 * Production seams for the software-engineer pipeline.
 *
 * Isolated from `handler.ts`/`cycle.ts` so the unit suite (which injects fakes)
 * never reaches the filesystem, a real `git`, `bun test`, or the store. These are
 * assembled by the daemon at wiring time (`daemon-run.ts`).
 *
 * TEST is the one place that needs a child process with a working directory: `bun
 * test` / `biome ci` resolve config + modules from cwd, and `RunOptions` has no cwd
 * field — so TEST shells out via `Bun.spawn({ cwd })` directly rather than through
 * the shared `runProcess` seam. Git still uses the `git -C <dir>` form.
 */

import { writeFile as fsWriteFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type AppendEventInput, openStore, runProcess } from "@vesper/core";
import type { ChangeDecisionCoordinator } from "./changes.ts";
import type { CycleDeps, RunTestResult } from "./cycle.ts";
import { makeGitRunner } from "./git.ts";
import type { SweBuildDeps } from "./handler.ts";
import type { Worktree } from "./worktree.ts";

const DB_PATH = join(homedir(), ".vesper", "vesper.db");

/** Max wall-clock for the worktree TEST step (5 minutes). */
const TEST_TIMEOUT_MS = 300_000;

/** Append one audit row through a freshly-opened store (closed after the write). */
function appendEventViaStore(input: AppendEventInput): string {
  const store = openStore(DB_PATH);
  try {
    return store.appendEvent(input);
  } finally {
    store.close();
  }
}

/** Write a file inside the worktree, creating parent directories as needed. */
async function writeFileEnsuringDir(absPath: string, contents: string): Promise<void> {
  await mkdir(dirname(absPath), { recursive: true });
  await fsWriteFile(absPath, contents, "utf8");
}

interface DirRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run a command with an explicit working directory (no shell, array form). */
async function spawnInDir(cwd: string, command: string, args: readonly string[]): Promise<DirRun> {
  const proc = Bun.spawn([command, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const killer = setTimeout(() => proc.kill(), TEST_TIMEOUT_MS);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(killer);
  }
}

function tail(text: string, max = 1200): string {
  return text.length <= max ? text : text.slice(-max);
}

/** Run `bun test` then `biome ci` inside the worktree; first failure short-circuits. */
async function defaultRunTest(wt: Worktree): Promise<RunTestResult> {
  const test = await spawnInDir(wt.path, "bun", ["test"]);
  if (test.exitCode !== 0) {
    return { passed: false, summary: `bun test failed:\n${tail(test.stdout + test.stderr)}` };
  }
  const lint = await spawnInDir(wt.path, "bunx", ["biome", "ci", "."]);
  if (lint.exitCode !== 0) {
    return { passed: false, summary: `biome ci failed:\n${tail(lint.stdout + lint.stderr)}` };
  }
  return { passed: true, summary: "bun test + biome ci passed" };
}

/** Resolve an auto-evolve `fix_proposal` event id to its `proposedFix` text, or null. */
function defaultLoadFixProposal(id: string): string | null {
  const store = openStore(DB_PATH);
  try {
    const row = store
      .listEvents()
      .find((r) => r.id === id && r.source === "auto-evolve" && r.kind === "fix_proposal");
    const fix = row?.payload?.proposedFix;
    return typeof fix === "string" ? fix : null;
  } finally {
    store.close();
  }
}

/** Production seams for the BUILD sub-agent. */
export function defaultBuildDeps(): SweBuildDeps {
  return { writeFile: writeFileEnsuringDir, appendEvent: appendEventViaStore };
}

/** Production seams for the lead, bound to the daemon's SHARED decision coordinator. */
export function defaultLeadDeps(coordinator: ChangeDecisionCoordinator): CycleDeps {
  return {
    git: makeGitRunner(runProcess),
    appendEvent: appendEventViaStore,
    coordinator,
    runTest: defaultRunTest,
    loadFixProposal: defaultLoadFixProposal,
  };
}
