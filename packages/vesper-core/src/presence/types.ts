import { VesperError } from "../errors.ts";

/**
 * A raw process row from the OS process table (one line of `ps -axo pid,etime,args`).
 * `args` is the full command line — detection matches against it because CLI agents
 * run as `node`/`bun` with the tool in their arguments, not as a `comm` of their own.
 */
export interface ProcessRow {
  readonly pid: number;
  /** Elapsed time as `ps` reports it, e.g. "01:23" or "1-02:03:04". */
  readonly etime: string;
  /** Full command line (`ps -o args`). */
  readonly args: string;
}

/**
 * Lists the current process table. Injected into detection so the matching logic
 * stays pure and unit tests never shell out (the suite shells out to nothing).
 */
export interface ProcessLister {
  list(): Promise<ProcessRow[]>;
}

/** Whether a detected agent is a CLI tool Vesper can orchestrate or a desktop app. */
export type PresenceKind = "cli" | "app";

/**
 * A serializable rule in the detection allowlist. A process is this agent when
 * `pattern` matches its args (case-insensitive) and `exclude` (if set) does not.
 * Specs are plain data so the allowlist can live in `~/.vesper/config.json`.
 */
export interface AgentMatcherSpec {
  readonly id: string;
  readonly label: string;
  readonly kind: PresenceKind;
  /** Regex source matched case-insensitively against the full args string. */
  readonly pattern: string;
  /** Optional regex source; rows whose args match this are skipped (e.g. Electron helpers). */
  readonly exclude?: string;
}

/**
 * One detected, running agent on this machine. Many OS processes (an Electron app
 * and its helper swarm) collapse into a single presence keyed by matcher `id`.
 */
export interface AgentPresence {
  /** Stable key (the matcher id) — the world uses it to key the creature across polls. */
  readonly id: string;
  readonly label: string;
  readonly kind: PresenceKind;
  /** The representative (main) process's pid. */
  readonly pid: number;
  /** How many matching processes collapsed into this presence. */
  readonly procCount: number;
  /** Elapsed time of the representative process. */
  readonly since: string;
}

/** Raised when the process table cannot be read. */
export class PresenceError extends VesperError {
  readonly reason: "ps_unavailable";

  constructor(reason: "ps_unavailable", message: string, options?: ErrorOptions) {
    super("presence", message, options);
    this.reason = reason;
  }
}
