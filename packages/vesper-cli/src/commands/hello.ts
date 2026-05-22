import { buildAdapter, detectAvailableCLIs, selectDefault } from "@vesper/core";
import { loadConfig } from "../config.ts";
import type { Command } from "../dispatch.ts";
import { dim, line } from "../ui.ts";

const HELLO_PROMPT =
  "Reply with a single sentence confirming you can read this message and identify yourself.";

export const helloCommand: Command = {
  name: "hello",
  summary: "Ask the configured CLI to reply — proves orchestration works (no Vesper API key).",
  usage: "vesper hello",
  async run() {
    const config = await loadConfig();
    const installed = await detectAvailableCLIs();
    const name = selectDefault(installed, config.cli.default);
    if (name === undefined) {
      throw new Error(
        "no CLI configured. Install claude / opencode / codex / gemini, then run `vesper init` (or `vesper cli select <name>`).",
      );
    }

    const adapter = buildAdapter(name);
    if (adapter === undefined) throw new Error(`unknown CLI adapter "${name}"`);

    line(dim(`asking ${name} ...`));
    // complete() shells out via Bun.spawn; CLIError on failure is printed by the dispatcher.
    const result = await adapter.complete(HELLO_PROMPT);
    line(result.text);
    return 0;
  },
};
