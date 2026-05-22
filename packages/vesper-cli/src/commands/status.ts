import {
  buildAdapter,
  CLIError,
  detectAvailableCLIs,
  ipcRequest,
  KeychainVault,
  selectDefault,
} from "@vesper/core";
import pkg from "../../package.json";
import { loadConfig } from "../config.ts";
import type { Command } from "../dispatch.ts";
import { dbPath, socketPath } from "../paths.ts";
import { dim, line, printSection, statusToken } from "../ui.ts";

async function storageStatus(): Promise<string> {
  return (await Bun.file(dbPath()).exists())
    ? `${statusToken("ok", "ok")}  ${dim(dbPath())}`
    : statusToken("warn", "not initialized — run `vesper init`");
}

async function vaultStatus(): Promise<string> {
  try {
    const keys = await new KeychainVault().list();
    return `${statusToken("ok", "ok")}  ${dim(`${keys.length} secret(s)`)}`;
  } catch (err) {
    return statusToken("bad", err instanceof Error ? err.message : "error");
  }
}

async function ipcStatus(): Promise<string> {
  try {
    const res = await ipcRequest(socketPath(), "ping", { timeoutMs: 500 });
    return res.ok
      ? `${statusToken("ok", "running")}  ${dim(`v${res.version}`)}`
      : statusToken("warn", "unexpected response");
  } catch {
    return statusToken("warn", "stopped");
  }
}

async function cliStatus(): Promise<string> {
  const config = await loadConfig();
  const installed = await detectAvailableCLIs();
  const name = selectDefault(installed, config.cli.default);
  if (name === undefined) return statusToken("warn", "none configured");

  const adapter = buildAdapter(name);
  if (adapter === undefined) return statusToken("bad", "unknown adapter");
  try {
    await adapter.probe();
    return `${statusToken("ok", "ok")}  ${dim(name)}`;
  } catch (err) {
    const reason = err instanceof CLIError ? err.reason.replace(/_/g, "-") : "error";
    return `${statusToken("warn", reason)}  ${dim(name)}`;
  }
}

export const statusCommand: Command = {
  name: "status",
  summary: "Show versions and the health of every subsystem.",
  usage: "vesper status",
  async run() {
    printSection("Versions", [
      ["vesper", pkg.version],
      ["bun", Bun.version],
    ]);
    line();
    printSection("Subsystems", [
      ["storage", await storageStatus()],
      ["vault", await vaultStatus()],
      ["ipc", await ipcStatus()],
      ["cli", await cliStatus()],
    ]);
    return 0;
  },
};
