/**
 * Read-only SKILL library for the Vesper World UI (`GET /api/skills`).
 *
 * Skills are file-based: the committed `<skillsDir>/<name>/SKILL.md` (+ optional
 * `tasks.json` validation harness) is the durable artifact, and the per-developer
 * training state (`best.md`, `history.jsonl`) lives under the skill-train dir. This
 * library reads BOTH and presents a unified view; it NEVER writes (training/accept/revert
 * stay on the `vesper skill` CLI, which is cost- and confirmation-gated). Skills are a
 * shared concept across pipelines and Vesper, so this is a plain read surface over them.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertSkillName,
  type HistoryEntry,
  parseFrontmatter,
  SkillTrainStore,
} from "@vesper/core";
import type { SkillDetail, SkillSummary, SkillTaskView } from "@vesper/ui";

/** Narrow `unknown` parsed JSON into the read-only task views (defensive — config-grade input). */
function toTaskViews(parsed: unknown): SkillTaskView[] {
  if (!Array.isArray(parsed)) return [];
  const out: SkillTaskView[] = [];
  for (const raw of parsed) {
    if (typeof raw !== "object" || raw === null) continue;
    const t = raw as Record<string, unknown>;
    out.push({
      id: typeof t.id === "string" ? t.id : "",
      prompt: typeof t.prompt === "string" ? t.prompt : "",
      expected: typeof t.expected === "string" ? t.expected : "",
      scorer: typeof t.scorer === "string" ? t.scorer : "contains",
    });
  }
  return out;
}

/** Read a skill's frontmatter tolerantly — never throws (an unparsable head -> dir-name fallback). */
function readFrontmatter(name: string, body: string): { displayName: string; description: string } {
  try {
    const fm = parseFrontmatter(body);
    return { displayName: fm.name, description: fm.description };
  } catch {
    return { displayName: name, description: "" };
  }
}

export class SkillLibrary {
  readonly #skillsDir: string;
  readonly #store: SkillTrainStore;

  constructor(opts: { readonly skillsDir: string; readonly trainDir: string }) {
    this.#skillsDir = opts.skillsDir;
    this.#store = new SkillTrainStore(opts.trainDir);
  }

  /** Read one skill's committed SKILL.md, or null when it has none. */
  async #readCommitted(name: string): Promise<string | null> {
    try {
      return await readFile(join(this.#skillsDir, name, "SKILL.md"), "utf8");
    } catch {
      return null;
    }
  }

  /** Read + count a skill's tasks.json, or null when it has no harness. */
  async #readTasks(name: string): Promise<SkillTaskView[] | null> {
    try {
      const raw = await readFile(join(this.#skillsDir, name, "tasks.json"), "utf8");
      return toTaskViews(JSON.parse(raw) as unknown);
    } catch {
      return null;
    }
  }

  /** Build a summary for one skill from its committed body + training state. */
  async #summarize(name: string, body: string): Promise<SkillSummary> {
    const { displayName, description } = readFrontmatter(name, body);
    const tasks = await this.#readTasks(name);
    const best = await this.#store.readBest(name).catch(() => null);
    const history = await this.#store.readHistory(name).catch((): HistoryEntry[] => []);
    const last = history.at(-1);
    return {
      name,
      displayName,
      description,
      taskCount: tasks === null ? null : tasks.length,
      hasCandidate: best !== null,
      differs: best !== null && best !== body,
      lastScore:
        last === undefined
          ? null
          : { prior: last.priorBestScore, candidate: last.candidateScore, accepted: last.accepted },
    };
  }

  /** Every skill (a directory with a SKILL.md) under the skills dir, name-sorted. */
  async list(): Promise<SkillSummary[]> {
    let entries: { name: string; isDirectory(): boolean }[];
    try {
      entries = await readdir(this.#skillsDir, { withFileTypes: true });
    } catch {
      return []; // no skills dir (e.g. an installed daemon outside the repo) -> empty, not an error
    }
    const summaries: SkillSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const body = await this.#readCommitted(entry.name);
      if (body === null) continue; // a dir without a SKILL.md is not a skill
      summaries.push(await this.#summarize(entry.name, body));
    }
    return summaries.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Full detail for one skill, or null when it has no committed SKILL.md. */
  async get(name: string): Promise<SkillDetail | null> {
    assertSkillName(name); // path-traversal boundary (throws on a crafted name)
    const body = await this.#readCommitted(name);
    if (body === null) return null;
    const summary = await this.#summarize(name, body);
    const best = await this.#store.readBest(name).catch(() => null);
    const tasks = (await this.#readTasks(name)) ?? [];
    const history = await this.#store.readHistory(name).catch((): HistoryEntry[] => []);
    return { ...summary, body, best, tasks, history };
  }
}
