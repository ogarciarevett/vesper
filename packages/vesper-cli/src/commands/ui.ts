import { ipcRequest } from "@vesper/core";
import type { Command } from "../dispatch.ts";
import { socketPath, uiPort } from "../paths.ts";
import { dim, errorLine, green, line } from "../ui.ts";

/** Open the OS default browser at `url` (best-effort; never throws). */
function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  } catch {
    // Best-effort; the URL is printed regardless.
  }
}

export const uiCommand: Command = {
  name: "ui",
  summary: "Open Vesper World — a visual, living view of your agents (requires the daemon).",
  usage: "vesper ui [--no-open]",
  async run({ flags }) {
    // The daemon hosts the UI in-process, so it must be running first.
    try {
      await ipcRequest(socketPath(), "ping", { timeoutMs: 500 });
    } catch {
      errorLine("the daemon isn't running — start it first, then retry:");
      line(dim("    vesper daemon start"));
      return 1;
    }

    const url = `http://127.0.0.1:${uiPort()}`;
    line(green(`Vesper World is live at ${url}`));
    if (flags["no-open"] !== true) {
      openBrowser(url);
      line(dim("  opening your browser…"));
    }
    return 0;
  },
};
