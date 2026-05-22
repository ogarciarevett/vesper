import { mkdir } from "node:fs/promises";
import { detectAvailableCLIs, openStore, selectDefault } from "@vesper/core";
import { loadConfig, saveConfig, type VesperConfig } from "../config.ts";
import type { Command } from "../dispatch.ts";
import { dbPath, runDir, vesperHome } from "../paths.ts";
import { dim, green, line, printSection } from "../ui.ts";

export const initCommand: Command = {
  name: "init",
  summary: "Create the ~/.vesper runtime, initialize storage, and detect installed CLIs.",
  usage: "vesper init",
  async run() {
    // mkdir of run/ also creates ~/.vesper.
    await mkdir(runDir(), { recursive: true });
    // Opening the store creates the DB file and runs migrations; close immediately.
    openStore(dbPath()).close();

    const installed = await detectAvailableCLIs();
    const existing = await loadConfig();
    const chosenDefault = selectDefault(installed, existing.cli.default);

    const cli: { default?: string; adapters: VesperConfig["cli"]["adapters"] } = {
      adapters: existing.cli.adapters,
    };
    if (chosenDefault !== undefined) cli.default = chosenDefault;
    await saveConfig({ cli });

    line(green("Vesper initialized."));
    line();
    printSection("Runtime", [
      ["home", vesperHome()],
      ["database", dbPath()],
    ]);
    line();
    printSection("CLIs", [
      ["installed", installed.length > 0 ? installed.join(", ") : dim("none detected")],
      ["default", chosenDefault ?? dim("none — install claude / opencode / codex / gemini")],
    ]);
    if (chosenDefault === undefined) {
      line();
      line(
        dim(
          "Tip: install a supported CLI, then re-run `vesper init` or `vesper cli select <name>`.",
        ),
      );
    }
    return 0;
  },
};
