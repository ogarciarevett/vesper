import { Database } from "bun:sqlite";
import type { ScheduledTask } from "@vesper/core";
import {
  CAPABILITIES,
  detectAvailableCLIs,
  HandlerRegistry,
  openStore,
  Scheduler,
  SchedulerError,
  TaskPersistence,
} from "@vesper/core";
import { registerPipelines } from "@vesper/pipelines";
import { makeCompleteFn } from "../cli-resolver.ts";
import { loadConfig } from "../config.ts";
import type { Command, CommandGroup } from "../dispatch.ts";
import { dbPath } from "../paths.ts";
import { bold, cyan, dim, errorLine, green, line, yellow } from "../ui.ts";

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

/** Strip ANSI escape codes for accurate string length measurement. */
function visibleLength(text: string): number {
  // ESC character as unicode escape to satisfy lint/suspicious/noControlCharactersInRegex.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI ESC must be matched literally
  return text.replace(/\[[0-9;]*m/g, "").length;
}

/** Pad a (possibly ANSI-colored) string to `width` visible characters. */
function padVisible(text: string, width: number): string {
  const extra = width - visibleLength(text);
  return extra > 0 ? `${text}${" ".repeat(extra)}` : text;
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
      const persistence = new TaskPersistence(db);
      const tasks = persistence.list();

      if (tasks.length === 0) {
        line(dim("no tasks registered"));
        return 0;
      }

      // Column header keys
      const H_ID = "id";
      const H_KIND = "kind";
      const H_EXPR = "schedule_expr";
      const H_ENABLED = "enabled";
      const H_LAST_RUN = "last_run";
      const H_ERROR = "last_error";

      // Compute column widths (visible chars only)
      const idW = Math.max(H_ID.length, ...tasks.map((t) => t.id.length));
      const kindW = Math.max(H_KIND.length, ...tasks.map((t) => t.kind.length));
      const exprW = Math.max(H_EXPR.length, ...tasks.map((t) => t.schedule_expr.length));
      const enabledW = Math.max(H_ENABLED.length, "yes".length);
      const lastRunW = Math.max(H_LAST_RUN.length, "2025-01-15 09:30:00".length);

      // Header row
      line(
        `  ${padVisible(bold(H_ID), idW)}  ${padVisible(bold(H_KIND), kindW)}  ${padVisible(bold(H_EXPR), exprW)}  ${padVisible(bold(H_ENABLED), enabledW)}  ${padVisible(bold(H_LAST_RUN), lastRunW)}  ${bold(H_ERROR)}`,
      );
      line(
        dim(
          `  ${"─".repeat(idW)}  ${"─".repeat(kindW)}  ${"─".repeat(exprW)}  ${"─".repeat(enabledW)}  ${"─".repeat(lastRunW)}  ${"─".repeat(20)}`,
        ),
      );

      for (const task of tasks) {
        const lastRun = formatTs(task.last_run_at);
        const errStr = fmt(task.last_error);
        line(
          `  ${padVisible(cyan(task.id), idW)}  ${padVisible(task.kind, kindW)}  ${padVisible(task.schedule_expr, exprW)}  ${padVisible(fmtEnabled(task.enabled), enabledW)}  ${padVisible(lastRun, lastRunW)}  ${errStr}`,
        );
      }
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
  usage: "vesper schedule run <id> [--cli <name>] [--param key=value]",
  async run({ positionals, flags }) {
    const id = positionals[0];
    if (id === undefined) throw new Error("usage: vesper schedule run <id> [--cli <name>]");

    // Params are transient (not persisted): `key=value` positionals after the id
    // and/or the `--param key=value` flag.
    const params = parseRunParams(positionals.slice(1), flags.param);
    const cli = typeof flags.cli === "string" ? flags.cli : undefined;

    const config = await loadConfig();
    const installed = await detectAvailableCLIs();
    const complete = makeCompleteFn(config, installed);

    const db = openDb();
    try {
      // Register pipelines first so their tasks (e.g. `echo`) exist before lookup.
      const registry = new HandlerRegistry();
      const scheduler = new Scheduler({ db, registry, grants: CAPABILITIES, complete });
      registerPipelines(scheduler, registry);

      // Look up the task so we can provide a useful error if it doesn't exist.
      const persistence = new TaskPersistence(db);
      const task = persistence.get(id);

      if (task === null) {
        errorLine(`task "${id}" not found — run \`vesper schedule list\` to see registered tasks`);
        return 1;
      }

      try {
        await scheduler.run(id, { ...(cli !== undefined ? { cli } : {}), params });
        line(green(`task "${id}" ran — recorded a run`));
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
