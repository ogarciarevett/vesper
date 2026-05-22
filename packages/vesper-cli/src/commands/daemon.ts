import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { HandlerRegistry, openStore, Scheduler, startIpcServer } from "@vesper/core";
import type { Command } from "../dispatch.ts";
import { dbPath, runDir, socketPath } from "../paths.ts";
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

    // Construct a Scheduler with an empty registry. Pipelines register handlers
    // at a later phase; tasks without handlers record an error on tick and are
    // not retried until a handler is available.
    const registry = new HandlerRegistry();
    const scheduler = new Scheduler({ db, registry });

    // Start the cron tick loop. The scheduler records per-task errors for any
    // task whose handler is not yet registered — this is expected until pipelines
    // are loaded.
    const tickInterval = setInterval(() => {
      void scheduler.tick().catch(() => {
        // tick() isolates per-task errors internally; if the outer promise ever
        // rejects it is an unexpected bug — swallow so the loop keeps running.
      });
    }, TICK_INTERVAL_MS);

    line(green("vesper daemon listening"));
    line(dim(`  socket:    ${handle.socketPath}`));
    line(dim(`  scheduler: tick every ${TICK_INTERVAL_MS / 1_000}s`));

    const shutdown = (): void => {
      clearInterval(tickInterval);
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
