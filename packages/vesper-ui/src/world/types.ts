/** UI-facing run-trace + presence types — the server-serialized shapes the client
 * renders directly (a thin renderer over `@vesper/core`). The former pixel-art
 * "world" model (SceneGraph/Inhabitant/buildWorld) was retired with the canvas;
 * these survivors back the Chat activity rail and the Diagnostics presence list. */

/**
 * A single live-trace step of a run, as the activity rail needs it — the UI-facing
 * shape of a `@vesper/core` `RunEventRow`. `kind` is one of
 * `step|log|progress|spawn|complete|usage`. A `usage` step's `data` carries
 * `{ usedTokens, limit, model }` — the activity rail uses it to update the run's
 * context pill live rather than appending a step row.
 */
export interface RunEventInfo {
  readonly id: string;
  readonly runId: string;
  /** Unix ms. */
  readonly ts: number;
  readonly kind: string;
  readonly message: string;
  readonly data?: Record<string, unknown>;
}

/**
 * The latest context-window fill recorded for a run — the UI-facing shape of a
 * `@vesper/core` `RunContext`. `usedTokens` is the prompt size of the run's most
 * recent CLI completion; `limit` is that model's window. Null when no usage was
 * captured (e.g. a CLI that does not report token usage).
 */
export interface RunContextInfo {
  readonly usedTokens: number;
  readonly limit: number;
  readonly model: string | null;
}

/**
 * The run hierarchy (a parent run and its spawned children), assembled server-side
 * from a `@vesper/core` `RunTreeNode` so the activity rail renders it directly.
 */
export interface RunTreeInfo {
  readonly run: {
    readonly id: string;
    readonly pipeline: string;
    readonly status: string;
    readonly summary: string;
    /** Unix ms. */
    readonly ts: number;
    readonly parentRunId: string | null;
    /** Latest context-window fill, or null if no usage was recorded for this run. */
    readonly context: RunContextInfo | null;
    /** Adapter that served the run's most recent completion (model-badge fallback). */
    readonly cli: string | null;
  };
  readonly children: readonly RunTreeInfo[];
}

/**
 * One line of a diff, GitHub-PR style. `kind` is `context` (unchanged, shown in
 * both columns), `insert` (added line, green), or `delete` (removed line, red).
 * `oldLine`/`newLine` are 1-based file line numbers (null on the side a line does
 * not exist). The UI-facing mirror of the software-engineer pipeline's `DiffLine`.
 */
export interface SweDiffLine {
  readonly kind: "context" | "insert" | "delete";
  readonly content: string;
  readonly oldLine: number | null;
  readonly newLine: number | null;
}

/** A contiguous diff hunk (`@@ ... @@`) with its lines. */
export interface SweDiffHunk {
  readonly header: string;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly SweDiffLine[];
}

/** One file's diff within a proposed change. */
export interface SweFileDiff {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly path: string;
  readonly status: "added" | "deleted" | "modified" | "renamed";
  readonly additions: number;
  readonly deletions: number;
  readonly binary: boolean;
  readonly hunks: readonly SweDiffHunk[];
}

/**
 * The structured diff of a software-engineer pipeline's proposed change, served by
 * `GET /api/runs/:runId/diff` and rendered as a GitHub-PR-style review. The
 * server-serialized mirror of the pipeline's `ParsedDiff`.
 */
export interface SweDiffView {
  readonly runId: string;
  readonly changeId: string;
  readonly staged: boolean;
  readonly files: readonly SweFileDiff[];
  readonly additions: number;
  readonly deletions: number;
  readonly fileCount: number;
}

/**
 * A live agent process detected on this machine (the "echo" of agents running) —
 * the UI-facing shape of a `@vesper/core` `AgentPresence`. These are NOT Vesper
 * pipelines; they are external agents (a `claude`/`codex` CLI, a desktop app) seen
 * via the process table. Surfaced in the Diagnostics section (not the home).
 */
export interface PresenceInfo {
  /** Matcher id, e.g. "claude-cli" (stable key across polls). */
  readonly id: string;
  readonly label: string;
  /** "cli" | "app". */
  readonly kind: string;
  /** Elapsed time the process has been up, as `ps` reports it. */
  readonly since: string;
  /** How many OS processes collapsed into this presence. */
  readonly procCount: number;
}

// ── Skills library (GET /api/skills) — shared skills across pipelines + Vesper ──────

/** One training epoch's outcome — the UI-facing shape of a core `HistoryEntry`. */
export interface SkillHistoryView {
  readonly epoch: number;
  readonly priorBestScore: number;
  readonly candidateScore: number;
  readonly accepted: boolean;
  readonly targetCli: string;
  readonly optimizerCli: string;
  readonly ts: string;
}

/** A skill's at-a-glance row for the library list. */
export interface SkillSummary {
  /** Directory name under the skills dir (the stable id). */
  readonly name: string;
  /** Frontmatter `name` (falls back to the dir name when frontmatter is absent/invalid). */
  readonly displayName: string;
  /** Frontmatter `description` (empty when absent). */
  readonly description: string;
  /** Validation task count, or null when the skill has no `tasks.json` (not trainable). */
  readonly taskCount: number | null;
  /** A trained candidate (`best.md`) exists for this skill. */
  readonly hasCandidate: boolean;
  /** The trained candidate differs from the committed SKILL.md (an adopt is pending). */
  readonly differs: boolean;
  /** The most recent training epoch's scores, when any training has run. */
  readonly lastScore: {
    readonly prior: number;
    readonly candidate: number;
    readonly accepted: boolean;
  } | null;
}

/** One validation task, surfaced read-only. */
export interface SkillTaskView {
  readonly id: string;
  readonly prompt: string;
  readonly expected: string;
  readonly scorer: string;
}

/** Full detail for one skill: the committed body, the trained candidate, tasks, and history. */
export interface SkillDetail extends SkillSummary {
  readonly body: string;
  readonly best: string | null;
  readonly tasks: readonly SkillTaskView[];
  readonly history: readonly SkillHistoryView[];
}
