import { type AdapterOptions, BaseAdapter } from "./base.ts";

/**
 * Adapter for Claude Code (`claude` CLI). Runs prompts via `claude -p <prompt>`,
 * which executes a single non-interactive completion and exits.
 *
 * Constructor accepts {@link AdapterOptions} so the CLI layer can override
 * command and args from `~/.vesper/config.json`.
 */
export class ClaudeCodeAdapter extends BaseAdapter {
  readonly name = "claude";
  protected readonly defaultCommand = "claude";
  protected readonly defaultArgs: readonly string[] = ["-p"];

  constructor(options: AdapterOptions = {}) {
    super(options);
  }
}
