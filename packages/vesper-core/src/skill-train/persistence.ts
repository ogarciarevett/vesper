import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SkillTrainError } from "./errors.ts";
import { assertSkillName } from "./name.ts";
import type { HistoryEntry } from "./types.ts";

/**
 * On-disk state for skill training, rooted at `baseDir`
 * (e.g. `~/.vesper/skill-train`). Per skill it keeps:
 *
 * - `<name>/best.md` — the current best SKILL.md candidate.
 * - `<name>/history.jsonl` — one {@link HistoryEntry} per epoch (append-only).
 *
 * The repo-committed `.ai/skills/<name>/SKILL.md` remains the durable artifact;
 * this store is the working, per-developer training state and is never the
 * source of truth until a user-acked IMPROVE copies `best.md` back.
 */
export class SkillTrainStore {
  readonly #baseDir: string;

  constructor(baseDir: string) {
    this.#baseDir = baseDir;
  }

  /** Directory holding a skill's training state. */
  dir(name: string): string {
    assertSkillName(name);
    return join(this.#baseDir, name);
  }

  bestPath(name: string): string {
    return join(this.dir(name), "best.md");
  }

  historyPath(name: string): string {
    return join(this.dir(name), "history.jsonl");
  }

  /** Read the current best candidate, or `null` if training has not run yet. */
  async readBest(name: string): Promise<string | null> {
    try {
      return await readFile(this.bestPath(name), "utf8");
    } catch (cause) {
      if (isNotFound(cause)) return null;
      throw new SkillTrainError("io_error", `failed to read best.md for "${name}"`, { cause });
    }
  }

  /** Write the best candidate, creating the skill's state directory if needed. */
  async writeBest(name: string, body: string): Promise<void> {
    await this.#ensureDir(name);
    try {
      await writeFile(this.bestPath(name), body, "utf8");
    } catch (cause) {
      throw new SkillTrainError("io_error", `failed to write best.md for "${name}"`, { cause });
    }
  }

  /** Append one epoch's outcome to the JSONL history log. */
  async appendHistory(name: string, entry: HistoryEntry): Promise<void> {
    await this.#ensureDir(name);
    try {
      await writeFile(this.historyPath(name), `${JSON.stringify(entry)}\n`, { flag: "a" });
    } catch (cause) {
      throw new SkillTrainError("io_error", `failed to append history for "${name}"`, { cause });
    }
  }

  /** Read every recorded epoch, oldest first. Returns `[]` when no history exists. */
  async readHistory(name: string): Promise<HistoryEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.historyPath(name), "utf8");
    } catch (cause) {
      if (isNotFound(cause)) return [];
      throw new SkillTrainError("io_error", `failed to read history for "${name}"`, { cause });
    }
    const entries: HistoryEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        entries.push(JSON.parse(trimmed) as HistoryEntry);
      } catch (cause) {
        throw new SkillTrainError("io_error", `corrupt history line for "${name}"`, { cause });
      }
    }
    return entries;
  }

  /** Directory holding a skill's pre-write SKILL.md snapshots (rollback trail). */
  checkpointsDir(name: string): string {
    return join(this.dir(name), "checkpoints");
  }

  /**
   * Snapshot a SKILL.md body before it is overwritten by an accepted candidate.
   * Checkpoints are append-only (one file per timestamp, never overwritten) so a
   * later `revert` can restore the exact prior bytes — git-independent rollback.
   * Returns the checkpoint's path.
   */
  async writeCheckpoint(name: string, body: string, at: number): Promise<string> {
    const dir = this.checkpointsDir(name);
    try {
      await mkdir(dir, { recursive: true });
      // Append-only (Hard rule 4): probe for the next free integer slot and write
      // exclusively (`wx`). A same-millisecond `at` or a backward clock can then
      // NEVER overwrite an existing checkpoint. Pure-integer names keep the numeric
      // sort in `listCheckpoints` / `readLatestCheckpoint` correct.
      for (let stamp = Math.max(1, Math.trunc(at)); ; stamp += 1) {
        const path = join(dir, `${stamp}.md`);
        try {
          await writeFile(path, body, { flag: "wx" });
          return path;
        } catch (cause) {
          if (!isAlreadyExists(cause)) throw cause;
        }
      }
    } catch (cause) {
      throw new SkillTrainError("io_error", `failed to write checkpoint for "${name}"`, { cause });
    }
  }

  /** Checkpoint timestamps for a skill, oldest first. `[]` when none exist. */
  async listCheckpoints(name: string): Promise<number[]> {
    let names: string[];
    try {
      names = await readdir(this.checkpointsDir(name));
    } catch (cause) {
      if (isNotFound(cause)) return [];
      throw new SkillTrainError("io_error", `failed to list checkpoints for "${name}"`, { cause });
    }
    return names
      .filter((n) => n.endsWith(".md"))
      .map((n) => Number(n.slice(0, -".md".length)))
      .filter((n) => Number.isInteger(n) && n > 0)
      .sort((a, b) => a - b);
  }

  /** Read the most recent checkpoint body, or `null` when nothing was ever accepted. */
  async readLatestCheckpoint(name: string): Promise<string | null> {
    const stamps = await this.listCheckpoints(name);
    const latest = stamps.at(-1);
    if (latest === undefined) return null;
    try {
      return await readFile(join(this.checkpointsDir(name), `${latest}.md`), "utf8");
    } catch (cause) {
      if (isNotFound(cause)) return null;
      throw new SkillTrainError("io_error", `failed to read checkpoint for "${name}"`, { cause });
    }
  }

  async #ensureDir(name: string): Promise<void> {
    try {
      await mkdir(this.dir(name), { recursive: true });
    } catch (cause) {
      throw new SkillTrainError("io_error", `failed to create state dir for "${name}"`, { cause });
    }
  }
}

/** True when an error is a Node "file not found" (ENOENT). */
function isNotFound(error: unknown): boolean {
  return hasCode(error, "ENOENT");
}

/** True when an error is a Node "file already exists" (EEXIST) — exclusive-write collision. */
function isAlreadyExists(error: unknown): boolean {
  return hasCode(error, "EEXIST");
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
