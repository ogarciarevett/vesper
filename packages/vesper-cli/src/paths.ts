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

/** Path to the daemon PID file (written by `vesper daemon run`). */
export function pidPath(): string {
  return join(runDir(), "vesperd.pid");
}

/** Path to the daemon's detached stdout/stderr log (used by `vesper daemon start`). */
export function daemonLogPath(): string {
  return join(runDir(), "daemon.log");
}

/** macOS LaunchAgent label for the daemon. */
export const LAUNCH_AGENT_LABEL = "com.ogarciarevett.vesper";

/** Path to the macOS LaunchAgent plist (`vesper daemon install`). */
export function launchAgentPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
}

/** Localhost port the daemon serves the Vesper World UI on (override: `VESPER_UI_PORT`). */
export function uiPort(): number {
  const raw = process.env.VESPER_UI_PORT;
  const n = raw !== undefined ? Number(raw) : Number.NaN;
  return Number.isInteger(n) && n > 0 ? n : 4317;
}
