import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import {
  detectAvailableCLIs,
  HandlerRegistry,
  openStore,
  Scheduler,
  startIpcServer,
} from "@vesper/core";
import { grantedCapabilities, PIPELINES, registerPipelines } from "@vesper/pipelines";
import { startUiServer } from "@vesper/ui";
import { machineFingerprint } from "../banner.ts";
import { makeCompleteFn } from "../cli-resolver.ts";
import { loadConfig } from "../config.ts";
import type { Command } from "../dispatch.ts";
import { dbPath, runDir, socketPath, uiPort } from "../paths.ts";
import { dim, green, line } from "../ui.ts";

/** Scheduler tick interval (1 minute). */
const TICK_INTERVAL_MS = 60_000;

export const daemonCommand: Command = {
  name: "daemon",
  summary: "Run the Vesper IPC server and scheduler loop. Foreground; Ctrl-C to stop.",
  usage: "vesper daemon",
  async run() {
    await mkdir(runDir(), { recursive: true });

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
    const uiStore = openStore(dbPath());
    const ui = await startUiServer({
      scheduler,
      store: uiStore,
      seed: machineFingerprint(),
      port: uiPort(),
    });

    // Start the cron tick loop. The scheduler records per-task errors for any
    // task whose handler is not registered — pipelines are now loaded above.
    const tickInterval = setInterval(() => {
      void scheduler.tick().catch(() => {
        // tick() isolates per-task errors internally; if the outer promise ever
        // rejects it is an unexpected bug — swallow so the loop keeps running.
      });
    }, TICK_INTERVAL_MS);

    line(green("vesper daemon listening"));
    line(dim(`  socket:    ${handle.socketPath}`));
    line(dim(`  scheduler: tick every ${TICK_INTERVAL_MS / 1_000}s`));
    line(dim(`  pipelines: ${PIPELINES.map((p) => p.handlerId).join(", ")}`));
    line(dim(`  ui:        ${ui.url}  (run \`vesper ui\` to open)`));

    const shutdown = (): void => {
      clearInterval(tickInterval);
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
