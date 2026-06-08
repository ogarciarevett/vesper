import { mkdir } from "node:fs/promises";
import { detectAvailableCLIs, openStore, selectDefault } from "@vesper/core";
import { loadConfig, saveConfig, type VesperConfig } from "../config.ts";
import type { Command } from "../dispatch.ts";
import { dbPath, runDir, vesperHome } from "../paths.ts";
import { dim, green, line, printSection } from "../ui.ts";

/** Default Ollama endpoint probed during onboarding to offer local embeddings. */
const OLLAMA_PROBE_URL = "http://localhost:11434/api/tags";

/**
 * Best-effort: is a local Ollama server up? Used only to tailor the onboarding hint
 * for semantic memory. Never throws and never blocks for long (short timeout).
 */
async function probeOllama(): Promise<boolean> {
  try {
    const res = await fetch(OLLAMA_PROBE_URL, { signal: AbortSignal.timeout(500) });
    return res.ok;
  } catch {
    return false;
  }
}

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
    // Preserve any existing config blocks (connections, voice, embeddings, ...) across a
    // re-init — only the cli block is recomputed from detection.
    await saveConfig({ ...existing, cli });

    line(green("Vesper initialized."));
    line();
    printSection("Runtime", [
      ["home", vesperHome()],
      ["database", dbPath()],
    ]);
    line();
    printSection("CLIs", [
      ["installed", installed.length > 0 ? installed.join(", ") : dim("none detected")],
      ["default", chosenDefault ?? dim("none — run `vesper cli install <name>`")],
    ]);
    if (chosenDefault === undefined) {
      line();
      line(
        dim(
          "no working CLI found — install one with `vesper cli install <claude|codex|opencode|gemini>`",
        ),
      );
      line(dim("(run `vesper cli list` after install to verify it's authenticated)"));
    }

    // Onboarding hint for semantic memory (RAG). Detect-and-offer, never silently enable.
    if (existing.embeddings === undefined) {
      line();
      const ollamaUp = await probeOllama();
      line(
        dim(
          ollamaUp
            ? "local Ollama detected — run `vesper rag setup` to enable semantic memory (recall by meaning)"
            : "tip: run `vesper rag setup` to enable semantic memory (recall your history by meaning)",
        ),
      );
    }

    return 0;
  },
};
