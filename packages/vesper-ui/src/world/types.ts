/** UI-facing run-trace + presence types — the server-serialized shapes the client
 * renders directly (a thin renderer over `@vesper/core`). The former pixel-art
 * "world" model (SceneGraph/Inhabitant/buildWorld) was retired with the canvas;
 * these survivors back the Chat activity rail and the Diagnostics presence list. */

/**
 * A single live-trace step of a run, as the activity rail needs it — the UI-facing
 * shape of a `@vesper/core` `RunEventRow`. `kind` is one of
 * `step|log|progress|spawn|complete`.
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
  };
  readonly children: readonly RunTreeInfo[];
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
