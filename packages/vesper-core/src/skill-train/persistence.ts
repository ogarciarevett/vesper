import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
