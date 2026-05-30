import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  acceptBest,
  assertSkillName,
  detectAvailableCLIs,
  HandlerRegistry,
  loadSkill,
  openStore,
  revertSkill,
  Scheduler,
  SkillTrainStore,
} from "@vesper/core";
import { grantedCapabilities, registerPipelines } from "@vesper/pipelines";
import { makeCompleteFn } from "../cli-resolver.ts";
import { loadConfig } from "../config.ts";
import type { Command, CommandGroup } from "../dispatch.ts";
import { dbPath, skillTrainDir, vesperHome } from "../paths.ts";
import { cyan, dim, errorLine, formatKeyValues, green, line, table } from "../ui.ts";

const DEFAULT_EPOCHS = 2;
const DEFAULT_BATCH_SIZE = 4;

/** Default location of the repo's trainable skills. */
const DEFAULT_SKILLS_DIR = ".ai/skills";

/**
 * Projected CLI calls for a training run: a baseline pass over all N tasks, then
 * per epoch a batch (min(batch, N)) + 1 optimizer call + an N-task validation pass.
 * Mirrors `trainSkill`'s loop so the confirmation prompt is honest about quota.
 * This is an UPPER BOUND: it ignores `--val-fraction` (a held-out split runs the
 * baseline/validation over fewer tasks), which only makes the real count smaller.
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

/**
 * Append an audit row to the `events` table (best-effort — an audit write must
 * never fail the user's action). Records evolve-skill promotions/rollbacks.
 */
function recordSkillEvent(kind: string, payload: Record<string, unknown>): void {
  try {
    const store = openStore(dbPath());
    try {
      store.appendEvent({ source: "skill-train", kind, payload });
    } finally {
      store.close();
    }
  } catch {
    // audit is best-effort; the SKILL.md write already succeeded.
  }
}

/**
 * Append the IMPROVE record to `cycle-log.md` when run inside the repo (the file
 * exists). Best-effort: the cycle-log is a nicety, never a gate on the action.
 */
async function appendImproveLog(
  name: string,
  store: SkillTrainStore,
  committedPath: string,
  checkpoint: string,
): Promise<void> {
  let scores = "scores n/a";
  try {
    const last = (await store.readHistory(name)).at(-1);
    if (last !== undefined) {
      scores = `prior ${last.priorBestScore} -> candidate ${last.candidateScore}`;
    }
  } catch {
    // history is optional context for the log line.
  }
  // Home-relative so a committed cycle-log.md never carries the developer's
  // absolute home path / OS username.
  const ref = relative(vesperHome(), checkpoint);
  const entry =
    `\n## skill-train IMPROVE — ${name} adopted\n\n` +
    `Adopted the trained best.md into ${committedPath} (${scores}). Checkpoint kept at ` +
    `${ref}; \`vesper skill revert ${name}\` restores the prior bytes.\n`;
  try {
    if (existsSync("cycle-log.md")) appendFileSync("cycle-log.md", entry, "utf8");
  } catch {
    // never fail the action on a cycle-log write.
  }
  line(dim(entry.trim()));
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
    "vesper skill train <name> [--cli <a>] [--optimizer-cli <a>] [--judge-cli <a>] [--epochs N] [--batchsize M] [--val-fraction F] [--dry-run] [--yes]",
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
    const valFraction = strFlag(flags["val-fraction"]);

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
      const scheduler = new Scheduler({
        db,
        registry,
        grants: grantedCapabilities(),
        complete,
        redactSummaries: config.storage?.redactRunSummaries === true,
      });
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
        ...(valFraction !== undefined ? { valFraction } : {}),
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

// ---------------------------------------------------------------------------
// accept
// ---------------------------------------------------------------------------

const acceptCommand: Command = {
  name: "accept",
  summary:
    "Adopt the trained best candidate into the committed SKILL.md (checkpointed; revertible).",
  usage: "vesper skill accept <name> [--skills-dir <dir>] [--yes]",
  async run({ positionals, flags }) {
    const name = positionals[0];
    if (name === undefined) throw new Error("usage: vesper skill accept <name>");
    assertSkillName(name); // enforce the path-traversal boundary at the entrypoint

    const skillsDir = strFlag(flags["skills-dir"]) ?? DEFAULT_SKILLS_DIR;
    const committedPath = join(skillsDir, name, "SKILL.md");
    const store = new SkillTrainStore(skillTrainDir());

    const best = await store.readBest(name);
    if (best === null) {
      line(dim(`no trained candidate for "${name}" yet — run \`vesper skill train ${name}\``));
      return 0;
    }
    if (!existsSync(committedPath)) {
      errorLine(`no committed SKILL.md for "${name}" at ${committedPath}`);
      return 1;
    }
    // Read the committed bytes ONCE: the same value is diffed, ack'd, checkpointed, and
    // overwritten — closing the TOCTOU window between the shown diff and the actual write.
    const committedBytes = readFileSync(committedPath, "utf8");
    if (committedBytes === best) {
      line(dim("no change — the trained best already matches the committed SKILL.md"));
      return 0;
    }

    // The human ack MUST see exactly what is being adopted (full unified diff).
    const proc = Bun.spawn(
      ["git", "diff", "--no-index", "--no-color", "--", committedPath, store.bestPath(name)],
      { stdout: "pipe", stderr: "pipe" },
    );
    line((await new Response(proc.stdout).text()).trimEnd());
    await proc.exited;
    line(
      dim(
        `This OVERWRITES ${committedPath} with the trained candidate (a checkpoint is kept for revert).`,
      ),
    );

    if (flags.yes !== true) {
      if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
        errorLine("non-interactive terminal — pass --yes to confirm the write");
        return 1;
      }
      if (!(await confirm("adopt this candidate? [y/N] "))) {
        errorLine("aborted");
        return 1;
      }
    }

    const result = await acceptBest({
      name,
      readCommitted: async () => committedBytes,
      readBest: async () => best,
      writeCommitted: async (body) => writeFileSync(committedPath, body, "utf8"),
      writeCheckpoint: async (body, at) => store.writeCheckpoint(name, body, at),
      now: () => Date.now(),
    });

    if (result.outcome === "no_change") {
      line(dim("no change — nothing to adopt"));
      return 0;
    }

    recordSkillEvent("skill_promoted", { skill: name, checkpoint: result.checkpoint });
    await appendImproveLog(name, store, committedPath, result.checkpoint);

    line(green(`adopted best.md -> ${committedPath}`));
    line(
      formatKeyValues([
        ["skill", name],
        ["checkpoint", result.checkpoint],
        ["next", `review + commit ${committedPath}, or \`vesper skill revert ${name}\` to undo`],
      ]),
    );
    return 0;
  },
};

// ---------------------------------------------------------------------------
// revert
// ---------------------------------------------------------------------------

const revertCommand: Command = {
  name: "revert",
  summary: "Restore the committed SKILL.md from the latest accept checkpoint.",
  usage: "vesper skill revert <name> [--skills-dir <dir>]",
  async run({ positionals, flags }) {
    const name = positionals[0];
    if (name === undefined) throw new Error("usage: vesper skill revert <name>");
    assertSkillName(name); // enforce the path-traversal boundary at the entrypoint

    const skillsDir = strFlag(flags["skills-dir"]) ?? DEFAULT_SKILLS_DIR;
    const committedPath = join(skillsDir, name, "SKILL.md");
    const store = new SkillTrainStore(skillTrainDir());

    const result = await revertSkill({
      name,
      readCommitted: async () =>
        existsSync(committedPath) ? readFileSync(committedPath, "utf8") : null,
      readLatestCheckpoint: async () => store.readLatestCheckpoint(name),
      writeCommitted: async (body) => writeFileSync(committedPath, body, "utf8"),
    });

    switch (result.outcome) {
      case "no_checkpoint":
        line(dim(`nothing to revert for "${name}" — no accept checkpoint recorded`));
        return 0;
      case "no_change":
        line(dim(`no change — "${name}" already matches the latest checkpoint`));
        return 0;
      default:
        recordSkillEvent("skill_reverted", { skill: name });
        line(green(`reverted ${committedPath} to the latest checkpoint`));
        return 0;
    }
  },
};

/** `vesper skill ...` — train, inspect, and evolve the repo's agent skills (skill-train engine). */
export const skillGroup: CommandGroup = {
  name: "skill",
  summary: "Train, inspect, and evolve agent skills (SkillOpt-style optimization).",
  subcommands: [trainCommand, listCommand, diffCommand, acceptCommand, revertCommand],
};
