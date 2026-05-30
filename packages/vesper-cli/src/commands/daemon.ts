import { closeSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ipcRequest, runProcess } from "@vesper/core";
import { removePidFile, resolveDaemonState } from "../daemon-lifecycle.ts";
import type { Command, CommandGroup } from "../dispatch.ts";
import { renderLaunchAgentPlist } from "../launchd.ts";
import {
  daemonLogPath,
  LAUNCH_AGENT_LABEL,
  launchAgentPath,
  pidPath,
  runDir,
  socketPath,
} from "../paths.ts";
import { dim, errorLine, formatKeyValues, green, line, statusToken, yellow } from "../ui.ts";
import { daemonRunCommand } from "./daemon-run.ts";

/** Sleep in small steps until `predicate` is true or the timeout elapses. */
async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  stepMs = 250,
): Promise<boolean> {
  const steps = Math.max(1, Math.ceil(timeoutMs / stepMs));
  for (let i = 0; i < steps; i++) {
    if (await predicate()) return true;
    await Bun.sleep(stepMs);
  }
  return predicate();
}

/** Ping the daemon's IPC socket; resolve the version string or null if unreachable. */
async function pingVersion(): Promise<string | null> {
  try {
    const res = await ipcRequest(socketPath(), "ping", { timeoutMs: 500 });
    return res.ok ? res.version : null;
  } catch {
    return null;
  }
}

/** Format a duration in ms as a short human string. */
function humanUptime(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

/** Resolve the argv that re-invokes this CLI (e.g. ["/path/bun", "/path/index.ts"]). */
function selfArgv(): string[] | null {
  const entry = process.argv[1];
  if (entry === undefined || entry.length === 0) return null;
  return [process.execPath, entry];
}

const startCommand: Command = {
  name: "start",
  summary: "Start the daemon in the background (detached).",
  usage: "vesper daemon start",
  async run() {
    const state = resolveDaemonState(pidPath());
    if (state.status === "running") {
      line(yellow(`daemon already running (PID ${state.pid})`));
      return 0;
    }

    const argv = selfArgv();
    if (argv === null) {
      errorLine("could not resolve the vesper entrypoint to spawn the daemon");
      return 1;
    }

    mkdirSync(runDir(), { recursive: true });
    const logFd = openSync(daemonLogPath(), "a");
    const child = Bun.spawn([...argv, "daemon", "run"], {
      stdin: "ignore",
      stdout: logFd,
      stderr: logFd,
    });
    child.unref(); // let it outlive this command
    closeSync(logFd);

    const up = await waitUntil(async () => (await pingVersion()) !== null, 6_000);
    if (!up) {
      errorLine(`daemon did not come up in time — check ${daemonLogPath()}`);
      return 1;
    }
    const started = resolveDaemonState(pidPath());
    const pid = started.status === "running" ? started.pid : child.pid;
    line(green(`daemon started (PID ${pid})`));
    line(dim("  run `vesper daemon status` to check it, `vesper ui` to open Vesper World"));
    return 0;
  },
};

const stopCommand: Command = {
  name: "stop",
  summary: "Stop the running daemon.",
  usage: "vesper daemon stop",
  async run() {
    const state = resolveDaemonState(pidPath());
    if (state.status === "stopped") {
      line(dim("daemon is not running"));
      return 0;
    }
    if (state.status === "stale") {
      removePidFile(pidPath());
      line(yellow(`removed a stale pidfile (PID ${state.pid} was not alive)`));
      return 0;
    }

    try {
      process.kill(state.pid, "SIGTERM");
    } catch (err) {
      errorLine(`could not signal PID ${state.pid}: ${err instanceof Error ? err.message : err}`);
      return 1;
    }
    const gone = await waitUntil(() => resolveDaemonState(pidPath()).status !== "running", 5_000);
    removePidFile(pidPath());
    line(
      gone
        ? green(`daemon stopped (PID ${state.pid})`)
        : yellow(`sent SIGTERM to PID ${state.pid}; still shutting down`),
    );
    return 0;
  },
};

const statusCommand: Command = {
  name: "status",
  summary: "Show the daemon's lifecycle status (PID, uptime, socket).",
  usage: "vesper daemon status",
  async run() {
    const state = resolveDaemonState(pidPath());
    const version = await pingVersion();

    if (state.status === "running") {
      const token =
        version !== null
          ? statusToken("ok", "running")
          : statusToken("warn", "running (socket not responding)");
      const rows: [string, string][] = [
        ["daemon", token],
        ["pid", String(state.pid)],
      ];
      if (state.since !== null) rows.push(["uptime", humanUptime(Date.now() - state.since)]);
      if (version !== null) rows.push(["version", version]);
      rows.push(["socket", socketPath()]);
      line(formatKeyValues(rows));
      return 0;
    }
    if (state.status === "stale") {
      line(
        formatKeyValues([
          ["daemon", statusToken("warn", "stopped (stale pidfile)")],
          ["pid", `${state.pid} (not alive)`],
          ["fix", "run `vesper daemon start`"],
        ]),
      );
      return 0;
    }
    line(
      formatKeyValues([
        ["daemon", statusToken("bad", "stopped")],
        ["fix", "run `vesper daemon start`"],
      ]),
    );
    return 0;
  },
};

const restartCommand: Command = {
  name: "restart",
  summary: "Restart the daemon (stop, then start).",
  usage: "vesper daemon restart",
  async run(args) {
    await stopCommand.run(args);
    return startCommand.run(args);
  },
};

const installCommand: Command = {
  name: "install",
  summary: "Install the daemon as a macOS LaunchAgent (starts at login, stays alive).",
  usage: "vesper daemon install",
  async run() {
    if (process.platform !== "darwin") {
      errorLine(
        "`vesper daemon install` is macOS-only (launchd). On other OSes, run `vesper daemon start`.",
      );
      return 1;
    }
    const argv = selfArgv();
    if (argv === null) {
      errorLine("could not resolve the vesper entrypoint for the LaunchAgent");
      return 1;
    }
    const plistPath = launchAgentPath();
    const plist = renderLaunchAgentPlist({
      label: LAUNCH_AGENT_LABEL,
      programArguments: [...argv, "daemon", "run"],
      stdoutPath: daemonLogPath(),
      stderrPath: daemonLogPath(),
    });
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, plist);
    // `load -w` registers + enables; harmless if already loaded.
    const res = await runProcess("launchctl", ["load", "-w", plistPath]).catch((e: unknown) => ({
      exitCode: 1,
      stderr: e instanceof Error ? e.message : String(e),
      stdout: "",
      durationMs: 0,
    }));
    if (res.exitCode !== 0) {
      errorLine(`wrote ${plistPath} but \`launchctl load\` failed: ${res.stderr.trim()}`);
      return 1;
    }
    line(green("daemon installed as a LaunchAgent"));
    line(dim(`  plist: ${plistPath}`));
    line(
      dim(
        "  it will start at login and restart if it crashes; `vesper daemon uninstall` to remove",
      ),
    );
    return 0;
  },
};

const uninstallCommand: Command = {
  name: "uninstall",
  summary: "Remove the macOS LaunchAgent and stop the daemon.",
  usage: "vesper daemon uninstall",
  async run() {
    if (process.platform !== "darwin") {
      errorLine("`vesper daemon uninstall` is macOS-only (launchd).");
      return 1;
    }
    const plistPath = launchAgentPath();
    // Unload first (ignore errors — it may not be loaded), then remove the plist.
    await runProcess("launchctl", ["unload", plistPath]).catch(() => undefined);
    try {
      rmSync(plistPath, { force: true });
    } catch (err) {
      errorLine(`could not remove ${plistPath}: ${err instanceof Error ? err.message : err}`);
      return 1;
    }
    line(green("daemon LaunchAgent removed"));
    line(dim(`  removed: ${plistPath}`));
    return 0;
  },
};

/**
 * `vesper daemon` — manage the background daemon. `run` is the foreground process
 * (what `start` spawns and launchd executes); `start`/`stop`/`restart`/`status`
 * manage it as a background process; `install`/`uninstall` register it with macOS
 * launchd for login persistence + crash recovery.
 */
export const daemonGroup: CommandGroup = {
  name: "daemon",
  summary: "Manage the Vesper background daemon (run, start, stop, status, install).",
  subcommands: [
    daemonRunCommand,
    startCommand,
    stopCommand,
    restartCommand,
    statusCommand,
    installCommand,
    uninstallCommand,
  ],
};
