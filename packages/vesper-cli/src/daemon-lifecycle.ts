import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";

/**
 * Daemon lifecycle state derived from the PID file + a liveness probe. Pure logic
 * (the probe + mtime reader are injectable) so it is fully unit-testable without a
 * real process.
 */
export type DaemonState =
  | { readonly status: "running"; readonly pid: number; readonly since: number | null }
  | { readonly status: "stale"; readonly pid: number }
  | { readonly status: "stopped" };

/** Read a PID from a pidfile; null if absent or malformed. */
export function readPidFile(path: string): number | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const pid = Number(raw.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** Write the PID file with owner-only perms (0600). */
export function writePidFile(path: string, pid: number): void {
  writeFileSync(path, `${pid}\n`, { mode: 0o600 });
}

/** Remove the PID file; ignore if already gone. */
export function removePidFile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // already gone — nothing to do.
  }
}

/** Default liveness probe: signal 0 throws iff the process does not exist. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Default pidfile mtime (ms) reader, for uptime; null if it can't be read. */
function pidFileMtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Resolve the daemon's state from its pidfile.
 *
 * - no/invalid pidfile -> `stopped`
 * - pidfile present but the process is gone -> `stale` (a crash left it behind)
 * - pidfile present and the process is alive -> `running` (with a start time from
 *   the pidfile mtime, used for uptime)
 *
 * @param pidfile - Path to the PID file.
 * @param alive - Liveness probe (injectable; defaults to {@link processAlive}).
 * @param mtime - Pidfile mtime reader (injectable for tests).
 */
export function resolveDaemonState(
  pidfile: string,
  alive: (pid: number) => boolean = processAlive,
  mtime: (path: string) => number | null = pidFileMtimeMs,
): DaemonState {
  const pid = readPidFile(pidfile);
  if (pid === null) return { status: "stopped" };
  if (!alive(pid)) return { status: "stale", pid };
  return { status: "running", pid, since: mtime(pidfile) };
}
