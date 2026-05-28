import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Root of the Vesper runtime tree (`~/.vesper`). Overridable via `VESPER_HOME`
 * so tests and alternate installs can point elsewhere.
 */
export function vesperHome(): string {
  const override = process.env.VESPER_HOME;
  return override !== undefined && override.length > 0 ? override : join(homedir(), ".vesper");
}

/** Path to the JSON config file. */
export function configPath(): string {
  return join(vesperHome(), "config.json");
}

/** Path to the SQLite database file. */
export function dbPath(): string {
  return join(vesperHome(), "vesper.db");
}

/** Directory holding runtime sockets/pidfiles. */
export function runDir(): string {
  return join(vesperHome(), "run");
}

/** Directory holding per-skill training state (best.md + history.jsonl). */
export function skillTrainDir(): string {
  return join(vesperHome(), "skill-train");
}

/** Path to the IPC Unix socket. */
export function socketPath(): string {
  return join(runDir(), "vesper.sock");
}
