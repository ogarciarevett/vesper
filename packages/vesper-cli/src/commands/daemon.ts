import { mkdir } from "node:fs/promises";
import { startIpcServer } from "@vesper/core";
import type { Command } from "../dispatch.ts";
import { runDir, socketPath } from "../paths.ts";
import { dim, green, line } from "../ui.ts";

export const daemonCommand: Command = {
  name: "daemon",
  summary: "Run the Vesper IPC server (Unix socket). Foreground; Ctrl-C to stop.",
  usage: "vesper daemon",
  async run() {
    await mkdir(runDir(), { recursive: true });
    const handle = startIpcServer({ socketPath: socketPath() });

    line(green("vesper daemon listening"));
    line(dim(`  socket: ${handle.socketPath}`));

    const shutdown = (): void => {
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
