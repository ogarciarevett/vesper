import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import {
  DEFAULT_AGENT_MATCHERS,
  detectAvailableCLIs,
  HandlerRegistry,
  openStore,
  Scheduler,
  startIpcServer,
} from "@vesper/core";
import { grantedCapabilities, PIPELINES, registerPipelines } from "@vesper/pipelines";
import { presenceDetectorFor, startUiServer } from "@vesper/ui";
import { machineFingerprint } from "../banner.ts";
import { makeCompleteFn } from "../cli-resolver.ts";
import { loadConfig } from "../config.ts";
import { removePidFile, resolveDaemonState, writePidFile } from "../daemon-lifecycle.ts";
import type { Command } from "../dispatch.ts";
import { dbPath, pidPath, runDir, socketPath, uiPort } from "../paths.ts";
import { dim, green, line, yellow } from "../ui.ts";

/** Scheduler tick interval (1 minute). */
const TICK_INTERVAL_MS = 60_000;

/**
 * `vesper daemon run` — the foreground daemon process: IPC server + scheduler tick
 * loop + the Vesper World UI, in one runtime. `vesper daemon start` spawns this
 * detached; macOS launchd runs it directly. Blocks until SIGINT/SIGTERM.
 *
 * Single-instance: refuses to start if a live daemon already holds the PID file
 * (a stale pidfile from a crash is overwritten). Writes its PID on start and
 * appends `daemon_started` / `daemon_stopped` to the audit (`events`) log.
 */
export const daemonRunCommand: Command = {
  name: "run",
  summary: "Run the daemon in the foreground (IPC + scheduler + UI). Ctrl-C to stop.",
  usage: "vesper daemon run",
  async run() {
    await mkdir(runDir(), { recursive: true });

    // Single-instance guard: one daemon holds the socket + DB.
    const existing = resolveDaemonState(pidPath());
    if (existing.status === "running") {
      line(yellow(`daemon already running (PID ${existing.pid})`));
      return 0;
    }

    // Ensure the database schema is fully migrated before opening for the scheduler.
    openStore(dbPath()).close();
    const db = new Database(dbPath());

    const handle = startIpcServer({ socketPath: socketPath() });

    // Resolve the CLI seam from config + detected CLIs so pipeline handlers can
    // shell out via `ctx.complete` (the same bring-your-own-CLI path as `vesper hello`).
    const config = await loadConfig();
    const installed = await detectAvailableCLIs();
    const complete = makeCompleteFn(config, installed);

    // Construct the Scheduler granting only the capabilities the built-in
    // pipelines actually declare (deny-by-default), with the CLI resolver, then
    // register the pipelines so their handlers + tasks are available to the tick loop.
    const registry = new HandlerRegistry();
    const scheduler = new Scheduler({
      db,
      registry,
      grants: grantedCapabilities(),
      complete,
      redactSummaries: config.storage?.redactRunSummaries === true,
    });
    registerPipelines(scheduler, registry);

    // Host the Vesper World UI in-process (one runtime): the UI reads this
    // scheduler + storage directly and gets live run events off its EventBus.
    // Agent-presence detection uses the built-in allowlist plus any matchers
    // the user added under `presence.matchers` in config; `presence.pollMs`
    // overrides the scan interval.
    const uiStore = openStore(dbPath());
    const presenceMatchers = [...DEFAULT_AGENT_MATCHERS, ...(config.presence?.matchers ?? [])];
    const ui = await startUiServer({
      scheduler,
      store: uiStore,
      seed: machineFingerprint(),
      port: uiPort(),
      detectPresences: presenceDetectorFor(presenceMatchers),
      ...(config.presence?.pollMs !== undefined ? { presencePollMs: config.presence.pollMs } : {}),
      ...(config.ui?.theme !== undefined ? { defaultTheme: config.ui.theme } : {}),
    });

    // Start the cron tick loop. The scheduler records per-task errors for any
    // task whose handler is not registered — pipelines are now loaded above.
    const tickInterval = setInterval(() => {
      void scheduler.tick().catch(() => {
        // tick() isolates per-task errors internally; if the outer promise ever
        // rejects it is an unexpected bug — swallow so the loop keeps running.
      });
    }, TICK_INTERVAL_MS);

    // Claim the PID file + audit the start now that everything is listening.
    writePidFile(pidPath(), process.pid);
    uiStore.appendEvent({
      source: "daemon",
      kind: "daemon_started",
      payload: { pid: process.pid, ui: ui.url },
    });

    line(green("vesper daemon listening"));
    line(dim(`  pid:       ${process.pid}`));
    line(dim(`  socket:    ${handle.socketPath}`));
    line(dim(`  scheduler: tick every ${TICK_INTERVAL_MS / 1_000}s`));
    line(dim(`  pipelines: ${PIPELINES.map((p) => p.handlerId).join(", ")}`));
    line(dim(`  ui:        ${ui.url}  (run \`vesper ui\` to open)`));

    let shuttingDown = false;
    const shutdown = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      clearInterval(tickInterval);
      try {
        uiStore.appendEvent({
          source: "daemon",
          kind: "daemon_stopped",
          payload: { pid: process.pid },
        });
      } catch {
        // best-effort audit; never block shutdown.
      }
      removePidFile(pidPath());
      ui.stop();
      uiStore.close();
      db.close();
      handle.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    // Block forever; the listener keeps the event loop alive until a signal arrives.
    await new Promise<void>(() => {});
    return 0;
  },
};
