/**
 * `vesper loop` — run and replay autonomous loops (specs/autonomous-loop.md,
 * DEV-113). The human directs WHICH loop runs (an objective + bounds); the model
 * authors every operational prompt. An autonomous loop spends the user's own CLI
 * quota, so `run` projects the cost up front and confirms on a TTY (the
 * `vesper skill train` pattern).
 */

import { Database } from "bun:sqlite";
import { createInterface } from "node:readline/promises";
import {
  detectAvailableCLIs,
  HandlerRegistry,
  LOOP_DEFAULT_MAX_ITERATIONS,
  LOOP_MAX_ITERATIONS_CEILING,
  openStore,
  type RunEventRow,
  Scheduler,
} from "@vesper/core";
import { grantedCapabilities, registerPipelines } from "@vesper/pipelines";
import { makeCompleteFn } from "../cli-resolver.ts";
import { loadConfig } from "../config.ts";
import type { Command, CommandGroup } from "../dispatch.ts";
import { dbPath } from "../paths.ts";
import { cyan, dim, errorLine, formatKeyValues, green, line, table } from "../ui.ts";

/** Each iteration is three CLI calls: AUTHOR, EXECUTE, CRITIC. */
const CALLS_PER_ITERATION = 3;

function strFlag(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function intFlag(value: string | boolean | undefined): number | undefined {
  if (typeof value !== "string") return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Ask a yes/no question on the TTY. EOF/anything-but-yes => false. */
async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(prompt)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } catch {
    return false;
  } finally {
    rl.close();
  }
}

/** Format a unix-ms timestamp as `YYYY-MM-DD HH:MM:SS`. */
function formatTs(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
}

/** Human label for a loop run-event kind (the engine's role mapping). */
function roleLabel(event: RunEventRow): string {
  switch (event.kind) {
    case "step":
      return "AUTHOR ";
    case "log":
      return "EXECUTE";
    case "progress":
      return "CRITIC ";
    default:
      return event.kind.padEnd(7);
  }
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

const runCommand: Command = {
  name: "run",
  summary: "Run an autonomous loop toward an objective (the model authors each prompt).",
  usage:
    'vesper loop run --goal "<objective>" [--success "<criteria>"] [--max N] [--no-progress K] ' +
    "[--budget-ms M] [--cli <a>] [--author-cli <a>] [--execute-cli <a>] [--critic-cli <a>] [--yes]",
  async run({ flags }) {
    const goal = strFlag(flags.goal);
    if (goal === undefined || goal.trim().length === 0) {
      errorLine('usage: vesper loop run --goal "<objective>" — the objective is required');
      return 1;
    }

    const maxIterations = Math.min(
      intFlag(flags.max) ?? LOOP_DEFAULT_MAX_ITERATIONS,
      LOOP_MAX_ITERATIONS_CEILING,
    );
    const projected = maxIterations * CALLS_PER_ITERATION;

    line(`Objective: ${cyan(goal)}`);
    line(
      dim(
        `Bounded at ${maxIterations} iteration(s) — projected CLI calls: ~${projected} ` +
          "(author + execute + critic per iteration), each using your own CLI quota.",
      ),
    );

    if (flags.yes !== true) {
      if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
        errorLine("non-interactive terminal — pass --yes to authorize the projected cost");
        return 1;
      }
      if (!(await confirm("start the loop? [y/N] "))) {
        errorLine("aborted");
        return 1;
      }
    }

    const cli = strFlag(flags.cli);
    const config = await loadConfig();
    const installed = await detectAvailableCLIs();
    const complete = makeCompleteFn(config, installed);

    // openStore applies migrations; the Scheduler then owns its own connection.
    openStore(dbPath()).close();
    const db = new Database(dbPath());
    try {
      const registry = new HandlerRegistry();
      const scheduler = new Scheduler({
        db,
        registry,
        grants: grantedCapabilities(),
        complete,
        redactSummaries: config.storage?.redactRunSummaries === true,
      });
      registerPipelines(scheduler, registry);

      const successCriteria = strFlag(flags.success);
      const maxNoProgress = intFlag(flags["no-progress"]);
      const maxTotalMs = intFlag(flags["budget-ms"]);
      const authorCli = strFlag(flags["author-cli"]);
      const executeCli = strFlag(flags["execute-cli"]);
      const criticCli = strFlag(flags["critic-cli"]);
      const params: Record<string, string> = {
        goal,
        maxIterations: String(maxIterations),
        ...(successCriteria !== undefined ? { successCriteria } : {}),
        ...(maxNoProgress !== undefined ? { maxNoProgress: String(maxNoProgress) } : {}),
        ...(maxTotalMs !== undefined ? { maxTotalMs: String(maxTotalMs) } : {}),
        ...(authorCli !== undefined ? { authorCli } : {}),
        ...(executeCli !== undefined ? { executeCli } : {}),
        ...(criticCli !== undefined ? { criticCli } : {}),
      };

      const outcome = await scheduler.run("loop", {
        ...(cli !== undefined ? { cli } : {}),
        params,
      });

      line(green("loop finished"));
      line(
        formatKeyValues([
          ["status", outcome.status ?? dim("(none)")],
          ["summary", outcome.summary ?? dim("(none)")],
          ["run", outcome.runId ?? dim("(none)")],
          ["duration", `${outcome.durationMs}ms`],
          ...(outcome.runId !== null
            ? ([["replay", `vesper loop show ${outcome.runId}`]] as [string, string][])
            : []),
        ]),
      );
      return 0;
    } finally {
      db.close();
    }
  },
};

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

const listCommand: Command = {
  name: "list",
  summary: "List recorded loop runs (oldest first).",
  usage: "vesper loop list [--limit <n>]",
  run({ flags }) {
    const limit = intFlag(flags.limit);
    const store = openStore(dbPath());
    try {
      const all = store.listRuns({ pipeline: "loop" });
      const runs = limit !== undefined ? all.slice(-limit) : all;
      if (runs.length === 0) {
        line(dim('no loop runs recorded — start one with `vesper loop run --goal "..."`'));
        return 0;
      }
      const rows = runs.map((r) => [formatTs(r.ts), r.status, r.summary, dim(r.id)]);
      line(table(["time", "status", "summary", "run id"], rows));
      return 0;
    } finally {
      store.close();
    }
  },
};

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

const showCommand: Command = {
  name: "show",
  summary: "Replay a loop run's iterations (author / execute / critic) from its live trace.",
  usage: "vesper loop show <runId>",
  run({ positionals }) {
    const runId = positionals[0];
    if (runId === undefined) {
      errorLine("usage: vesper loop show <runId>");
      return 1;
    }
    const store = openStore(dbPath());
    try {
      const run = store.listRuns({ pipeline: "loop" }).find((r) => r.id === runId);
      const events = store
        .listRunEvents({ runId })
        .filter((e) => e.kind === "step" || e.kind === "log" || e.kind === "progress");
      if (run === undefined && events.length === 0) {
        errorLine(`no loop run found with id ${runId}`);
        return 1;
      }
      if (run !== undefined) {
        line(
          formatKeyValues([
            ["status", run.status],
            ["summary", run.summary],
          ]),
        );
        line();
      }
      for (const event of events) {
        const message = typeof event.payload.message === "string" ? event.payload.message : "";
        line(`${dim(formatTs(event.ts))}  ${cyan(roleLabel(event))} ${message}`);
      }
      if (events.length === 0) line(dim("no live-trace steps recorded for this run"));
      return 0;
    } finally {
      store.close();
    }
  },
};

/** `vesper loop ...` — LLM-authored self-prompting loops, human-directed. */
export const loopGroup: CommandGroup = {
  name: "loop",
  summary: "Run autonomous loops: you set the objective, the model authors the prompts.",
  subcommands: [runCommand, listCommand, showCommand],
};
