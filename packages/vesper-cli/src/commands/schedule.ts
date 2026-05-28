import { Database } from "bun:sqlite";
import type { ScheduledTask } from "@vesper/core";
import {
  detectAvailableCLIs,
  HandlerRegistry,
  openStore,
  Scheduler,
  SchedulerError,
  TaskPersistence,
} from "@vesper/core";
import { grantedCapabilities, registerPipelines } from "@vesper/pipelines";
import { makeCompleteFn } from "../cli-resolver.ts";
import { loadConfig } from "../config.ts";
import type { Command, CommandGroup } from "../dispatch.ts";
import { dbPath } from "../paths.ts";
import { bold, cyan, dim, errorLine, formatKeyValues, green, line, table, yellow } from "../ui.ts";

/**
 * Parse transient run params from the tokens that follow the task id.
 *
 * Two equivalent forms are accepted: bare `key=value` positionals
 * (`vesper schedule run echo prompt="hi"`) and the `--param key=value` flag
 * (the parser treats `param` as a value-flag, so `--param prompt=hi` arrives as
 * the string `flags.param`). Each `key=value` becomes a param entry; tokens
 * without an `=` are ignored. The value keeps everything after the first `=`, so
 * `a=b=c` yields `{ a: "b=c" }`.
 */
export function parseRunParams(
  positionals: readonly string[],
  paramFlag?: string | boolean,
): Record<string, string> {
  const params: Record<string, string> = {};
  const tokens = typeof paramFlag === "string" ? [...positionals, paramFlag] : positionals;
  for (const token of tokens) {
    const eq = token.indexOf("=");
    if (eq < 0) continue;
    params[token.slice(0, eq)] = token.slice(eq + 1);
  }
  return params;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Open the database, ensuring all migrations are applied.
 * Returns the raw Database for use with the Scheduler/TaskPersistence.
 * The caller is responsible for closing it.
 */
function openDb(): Database {
  // Calling openStore ensures schema migrations (including scheduler tables) are applied.
  openStore(dbPath()).close();
  return new Database(dbPath());
}

/** Format a nullable unix-ms timestamp as a human-readable string. */
function formatTs(ts: number | null): string {
  if (ts === null) return dim("never");
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
}

/** Format a nullable string, falling back to a dimmed placeholder. */
function fmt(value: string | null, placeholder = "—"): string {
  if (value === null || value.length === 0) return dim(placeholder);
  return value;
}

/** Format a boolean as a colored token. */
function fmtEnabled(enabled: boolean): string {
  return enabled ? green("yes") : yellow("no");
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

const listCommand: Command = {
  name: "list",
  summary: "List all scheduled tasks in an aligned table.",
  usage: "vesper schedule list",
  run() {
    const db = openDb();
    try {
      const tasks = new TaskPersistence(db).list();
      if (tasks.length === 0) {
        line(dim("no tasks registered"));
        return 0;
      }
      const rows = tasks.map((t) => [
        cyan(t.id),
        t.kind,
        t.schedule_expr,
        fmtEnabled(t.enabled),
        formatTs(t.last_run_at),
        fmt(t.last_error),
      ]);
      line(table(["id", "kind", "schedule_expr", "enabled", "last_run", "last_error"], rows));
      return 0;
    } finally {
      db.close();
    }
  },
};

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

function printTask(task: ScheduledTask): void {
  line(bold(`Task: ${task.id}`));
  line();

  const rows: readonly (readonly [string, string])[] = [
    ["id", cyan(task.id)],
    ["kind", task.kind],
    ["schedule_expr", fmt(task.schedule_expr, "(none)")],
    ["handler_id", task.handler_id],
    ["enabled", fmtEnabled(task.enabled)],
    ["last_run_at", formatTs(task.last_run_at)],
    ["last_error", fmt(task.last_error)],
    [
      "max_runs_per_day",
      task.max_runs_per_day !== null ? String(task.max_runs_per_day) : dim("unlimited"),
    ],
    [
      "max_concurrent",
      task.max_concurrent !== null ? String(task.max_concurrent) : dim("unlimited"),
    ],
    [
      "max_duration_ms",
      task.max_duration_ms !== null ? `${task.max_duration_ms}ms` : dim("unlimited"),
    ],
    ["attempt_count", String(task.attempt_count)],
    ["next_attempt_at", formatTs(task.next_attempt_at)],
    [
      "required_capabilities",
      task.required_capabilities.length > 0 ? task.required_capabilities.join(", ") : dim("none"),
    ],
  ];

  const width = rows.reduce((max, [key]) => Math.max(max, key.length), 0);
  for (const [key, value] of rows) {
    line(`  ${dim(key.padEnd(width))}  ${value}`);
  }
}

const showCommand: Command = {
  name: "show",
  summary: "Print full details for a single task.",
  usage: "vesper schedule show <id>",
  run({ positionals }) {
    const id = positionals[0];
    if (id === undefined) throw new Error("usage: vesper schedule show <id>");

    const db = openDb();
    try {
      const persistence = new TaskPersistence(db);
      const task = persistence.get(id);

      if (task === null) {
        errorLine(`task "${id}" not found — run \`vesper schedule list\` to see registered tasks`);
        return 1;
      }

      printTask(task);
      return 0;
    } finally {
      db.close();
    }
  },
};

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

const runCommand: Command = {
  name: "run",
  summary: "Manually run a task by id, invoking the resolved CLI and recording a run.",
  usage: "vesper schedule run <id> [--cli <name>] [--param key=value] [--quiet]",
  async run({ positionals, flags }) {
    const id = positionals[0];
    if (id === undefined) throw new Error("usage: vesper schedule run <id> [--cli <name>]");

    // Params are transient (not persisted): `key=value` positionals after the id
    // and/or the `--param key=value` flag.
    const params = parseRunParams(positionals.slice(1), flags.param);
    const cli = typeof flags.cli === "string" ? flags.cli : undefined;
    const quiet = flags.quiet === true;

    const config = await loadConfig();
    const installed = await detectAvailableCLIs();
    const complete = makeCompleteFn(config, installed);

    const db = openDb();
    try {
      // Register pipelines first so their tasks (e.g. `echo`) exist before lookup.
      const registry = new HandlerRegistry();
      const scheduler = new Scheduler({
        db,
        registry,
        grants: grantedCapabilities(),
        complete,
        redactSummaries: config.storage?.redactRunSummaries === true,
      });
      registerPipelines(scheduler, registry);

      // Look up the task so we can provide a useful error if it doesn't exist.
      const persistence = new TaskPersistence(db);
      const task = persistence.get(id);

      if (task === null) {
        errorLine(`task "${id}" not found — run \`vesper schedule list\` to see registered tasks`);
        return 1;
      }

      try {
        const outcome = await scheduler.run(id, { ...(cli !== undefined ? { cli } : {}), params });
        if (!quiet) {
          line(green(`task "${id}" ran`));
          line(
            formatKeyValues([
              ["status", outcome.status ?? dim("(none recorded)")],
              ["cli", outcome.cli ?? dim("default")],
              ["duration", `${outcome.durationMs}ms`],
              ["run id", outcome.runId ?? dim("(none)")],
              ["summary", fmt(outcome.summary)],
            ]),
          );
        }
        return 0;
      } catch (err) {
        if (err instanceof SchedulerError && err.reason === "unknown_handler") {
          errorLine(
            `no handler registered for "${task.handler_id}" — handlers are provided by pipelines`,
          );
          return 1;
        }
        // Re-throw unexpected errors (CLIError, CapabilityError, ...) so the
        // dispatch boundary can print them as one actionable line.
        throw err;
      }
    } finally {
      db.close();
    }
  },
};

// ---------------------------------------------------------------------------
// enable / disable
// ---------------------------------------------------------------------------

function makeToggleCommand(enabled: boolean): Command {
  const verb = enabled ? "enable" : "disable";
  const past = enabled ? "enabled" : "disabled";
  return {
    name: verb,
    summary: `${enabled ? "Enable" : "Disable"} a scheduled task by id.`,
    usage: `vesper schedule ${verb} <id>`,
    run({ positionals }) {
      const id = positionals[0];
      if (id === undefined) throw new Error(`usage: vesper schedule ${verb} <id>`);

      const db = openDb();
      try {
        const persistence = new TaskPersistence(db);
        const task = persistence.get(id);

        if (task === null) {
          errorLine(
            `task "${id}" not found — run \`vesper schedule list\` to see registered tasks`,
          );
          return 1;
        }

        persistence.setEnabled(id, enabled);
        line(green(`task "${id}" ${past}`));
        return 0;
      } finally {
        db.close();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Group export
// ---------------------------------------------------------------------------

export const scheduleGroup: CommandGroup = {
  name: "schedule",
  summary: "Inspect and control scheduled tasks.",
  subcommands: [
    listCommand,
    showCommand,
    runCommand,
    makeToggleCommand(true),
    makeToggleCommand(false),
  ],
};
