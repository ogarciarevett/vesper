import { ADAPTER_REGISTRY, buildAdapter, CLIError, detectAvailableCLIs } from "@vesper/core";
import { loadConfig, saveConfig } from "../config.ts";
import type { Command, CommandGroup } from "../dispatch.ts";
import { formatKeyValues, green, type Health, line, statusToken } from "../ui.ts";

/** Probe an installed adapter and render its status token. */
async function probeStatus(name: string): Promise<string> {
  const adapter = buildAdapter(name);
  if (adapter === undefined) return statusToken("bad", "unknown");
  try {
    await adapter.probe();
    return statusToken("ok", "ok");
  } catch (err) {
    if (err instanceof CLIError) {
      const health: Health = err.reason === "not_installed" ? "bad" : "warn";
      return statusToken(health, err.reason.replace(/_/g, "-"));
    }
    return statusToken("bad", "error");
  }
}

const listCommand: Command = {
  name: "list",
  summary: "List supported CLIs and their probe status.",
  usage: "vesper cli list",
  async run() {
    const installed = new Set(await detectAvailableCLIs());
    const rows: [string, string][] = [];
    for (const name of Object.keys(ADAPTER_REGISTRY)) {
      rows.push([
        name,
        installed.has(name) ? await probeStatus(name) : statusToken("bad", "not-installed"),
      ]);
    }
    line(formatKeyValues(rows));
    return 0;
  },
};

const selectCommand: Command = {
  name: "select",
  summary: "Set the default CLI adapter (must be installed).",
  usage: "vesper cli select <name>",
  async run({ positionals }) {
    const name = positionals[0];
    if (name === undefined) throw new Error("usage: vesper cli select <name>");
    const installed = await detectAvailableCLIs();
    if (!installed.includes(name)) {
      const detected = installed.length > 0 ? installed.join(", ") : "none";
      throw new Error(`"${name}" is not installed (detected: ${detected})`);
    }
    const config = await loadConfig();
    await saveConfig({ cli: { default: name, adapters: config.cli.adapters } });
    line(green(`default CLI set to "${name}"`));
    return 0;
  },
};

export const cliGroup: CommandGroup = {
  name: "cli",
  summary: "Inspect and select the LLM CLI Vesper orchestrates.",
  subcommands: [listCommand, selectCommand],
};
