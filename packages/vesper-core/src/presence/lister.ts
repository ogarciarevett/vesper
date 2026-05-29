import { type ProcessRunner, runProcess } from "../process/run.ts";
import { PresenceError, type ProcessLister, type ProcessRow } from "./types.ts";

/**
 * Parse `ps -axo pid=,etime=,args=` output into rows (pure; exported for tests).
 * The trailing `=` on each field suppresses the header line, so every non-blank
 * line is a process. `pid` and `etime` are whitespace-free; everything after the
 * second field is the (space-containing) command line.
 */
export function parsePsOutput(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trimStart();
    if (trimmed.length === 0) continue;
    const match = /^(\d+)\s+(\S+)\s+(.*)$/.exec(trimmed);
    if (match === null) continue;
    const pid = Number(match[1]);
    if (!Number.isInteger(pid)) continue;
    rows.push({ pid, etime: match[2] ?? "", args: match[3] ?? "" });
  }
  return rows;
}

/**
 * A {@link ProcessLister} backed by the macOS `ps` command, going through the
 * injectable {@link ProcessRunner} seam so unit tests never shell out. The
 * `ProcessLister` interface keeps Linux/Windows backends a drop-in later.
 *
 * @param runner - Process runner (defaults to the real `runProcess`).
 * @throws {PresenceError} reason `"ps_unavailable"` if `ps` cannot be run or fails.
 */
export function psProcessLister(runner: ProcessRunner = runProcess): ProcessLister {
  return {
    async list(): Promise<ProcessRow[]> {
      let result: Awaited<ReturnType<ProcessRunner>>;
      try {
        result = await runner("ps", ["-axo", "pid=,etime=,args="], { timeoutMs: 5_000 });
      } catch (cause) {
        throw new PresenceError("ps_unavailable", "could not run ps to read the process table", {
          cause,
        });
      }
      if (result.exitCode !== 0) {
        throw new PresenceError(
          "ps_unavailable",
          `ps exited with code ${result.exitCode}: ${result.stderr.trim()}`,
        );
      }
      return parsePsOutput(result.stdout);
    },
  };
}
