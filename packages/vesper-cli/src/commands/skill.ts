import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  detectAvailableCLIs,
  HandlerRegistry,
  loadSkill,
  openStore,
  Scheduler,
} from "@vesper/core";
import { grantedCapabilities, registerPipelines } from "@vesper/pipelines";
import { makeCompleteFn } from "../cli-resolver.ts";
import { loadConfig } from "../config.ts";
import type { Command, CommandGroup } from "../dispatch.ts";
import { dbPath, skillTrainDir } from "../paths.ts";
import { cyan, dim, errorLine, formatKeyValues, green, line, table } from "../ui.ts";

const DEFAULT_EPOCHS = 2;
const DEFAULT_BATCH_SIZE = 4;

/** Default location of the repo's trainable skills. */
const DEFAULT_SKILLS_DIR = ".ai/skills";

/**
 * Projected CLI calls for a training run: a baseline pass over all N tasks, then
 * per epoch a batch (min(batch, N)) + 1 optimizer call + an N-task validation pass.
 * Mirrors `trainSkill`'s loop so the confirmation prompt is honest about quota.
 */
export function projectCalls(taskCount: number, epochs: number, batchSize: number): number {
  const batch = Math.min(batchSize, taskCount);
  return taskCount + epochs * (batch + 1 + taskCount);
}

function strFlag(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function intFlag(value: string | boolean | undefined, fallback: number): number {
  if (typeof value !== "string") return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
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

function openDb(): Database {
  openStore(dbPath()).close();
  return new Database(dbPath());
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

const listCommand: Command = {
  name: "list",
  summary: "List trainable skills (those with a tasks.json validation harness).",
  usage: "vesper skill list [--skills-dir <dir>]",
  run({ flags }) {
    const skillsDir = strFlag(flags["skills-dir"]) ?? DEFAULT_SKILLS_DIR;
    if (!existsSync(skillsDir)) {
      line(dim(`no skills directory at ${skillsDir}`));
      return 0;
    }
    const rows: string[][] = [];
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const tasksPath = join(skillsDir, entry.name, "tasks.json");
      if (!existsSync(tasksPath)) continue;
      let count = "?";
      try {
        const parsed: unknown = JSON.parse(readFileSync(tasksPath, "utf8"));
        if (Array.isArray(parsed)) count = String(parsed.length);
      } catch {
        count = dim("invalid");
      }
      rows.push([cyan(entry.name), count]);
    }
    if (rows.length === 0) {
      line(dim("no trainable skills found (none have a tasks.json)"));
      return 0;
    }
    line(table(["skill", "tasks"], rows));
    return 0;
  },
};

// ---------------------------------------------------------------------------
// train
// ---------------------------------------------------------------------------

const trainCommand: Command = {
  name: "train",
  summary: "Train a skill against its tasks.json via the skill-train pipeline.",
  usage:
    "vesper skill train <name> [--cli <a>] [--optimizer-cli <a>] [--judge-cli <a>] [--epochs N] [--batchsize M] [--dry-run] [--yes]",
  async run({ positionals, flags }) {
    const name = positionals[0];
    if (name === undefined) throw new Error("usage: vesper skill train <name>");

    const skillsDir = strFlag(flags["skills-dir"]) ?? DEFAULT_SKILLS_DIR;
    const epochs = intFlag(flags.epochs, DEFAULT_EPOCHS);
    const batchsize = intFlag(flags.batchsize, DEFAULT_BATCH_SIZE);
    const dryRun = flags["dry-run"] === true;
    const cli = strFlag(flags.cli);
    const optimizerCli = strFlag(flags["optimizer-cli"]);
    const judgeCli = strFlag(flags["judge-cli"]);

    // Load the skill first to count tasks (and fail early if it/its harness is missing).
    const skill = await loadSkill(name, { skillsDir });
    const projected = projectCalls(skill.tasks.length, epochs, batchsize);

    line(
      `Training ${cyan(name)}: ${skill.tasks.length} task(s), ${epochs} epoch(s), batch ${batchsize}${dryRun ? dim(" (dry-run)") : ""}.`,
    );
    line(dim(`Projected CLI calls: ~${projected} — each uses your own CLI quota.`));

    if (flags.yes !== true) {
      if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
        errorLine("non-interactive terminal — pass --yes to confirm the run");
        return 1;
      }
      if (!(await confirm("proceed? [y/N] "))) {
        errorLine("aborted");
        return 1;
      }
    }

    const config = await loadConfig();
    const installed = await detectAvailableCLIs();
    const complete = makeCompleteFn(config, installed);

    const db = openDb();
    try {
      const registry = new HandlerRegistry();
      const scheduler = new Scheduler({ db, registry, grants: grantedCapabilities(), complete });
      registerPipelines(scheduler, registry);

      const params: Record<string, string> = {
        skill: name,
        skillsDir,
        stateDir: skillTrainDir(),
        epochs: String(epochs),
        batchsize: String(batchsize),
        ...(dryRun ? { dryRun: "true" } : {}),
        ...(optimizerCli !== undefined ? { optimizerCli } : {}),
        ...(judgeCli !== undefined ? { judgeCli } : {}),
        ...(cli !== undefined ? { cli } : {}),
      };

      const outcome = await scheduler.run("skill-train", {
        ...(cli !== undefined ? { cli } : {}),
        params,
      });

      line(green(`skill-train ${name} ran`));
      line(
        formatKeyValues([
          ["status", outcome.status ?? dim("(none)")],
          ["summary", outcome.summary ?? dim("(none)")],
          ["best.md", join(skillTrainDir(), name, "best.md")],
          ["duration", `${outcome.durationMs}ms`],
        ]),
      );
      return 0;
    } finally {
      db.close();
    }
  },
};

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

const diffCommand: Command = {
  name: "diff",
  summary: "Diff the committed SKILL.md against the trained best candidate.",
  usage: "vesper skill diff <name> [--skills-dir <dir>]",
  async run({ positionals, flags }) {
    const name = positionals[0];
    if (name === undefined) throw new Error("usage: vesper skill diff <name>");

    const skillsDir = strFlag(flags["skills-dir"]) ?? DEFAULT_SKILLS_DIR;
    const committed = join(skillsDir, name, "SKILL.md");
    const best = join(skillTrainDir(), name, "best.md");

    if (!existsSync(best)) {
      line(dim(`no trained candidate for "${name}" yet — run \`vesper skill train ${name}\``));
      return 0;
    }
    if (!existsSync(committed)) {
      errorLine(`no committed SKILL.md for "${name}" at ${committed}`);
      return 1;
    }
    if (readFileSync(committed, "utf8") === readFileSync(best, "utf8")) {
      line(dim("no difference — the trained best matches the committed SKILL.md"));
      return 0;
    }

    // `git diff --no-index` renders a clean unified diff of two files (exit 1 = differ).
    const proc = Bun.spawn(["git", "diff", "--no-index", "--no-color", "--", committed, best], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    line(out.trimEnd());
    return 0;
  },
};

/** `vesper skill ...` — train + inspect the repo's agent skills (skill-train engine). */
export const skillGroup: CommandGroup = {
  name: "skill",
  summary: "Train and inspect agent skills (SkillOpt-style optimization).",
  subcommands: [trainCommand, listCommand, diffCommand],
};
