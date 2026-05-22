import { type AdapterOptions, BaseAdapter } from "./base.ts";

/**
 * Adapter for OpenCode (`opencode` CLI). Runs prompts via `opencode run <prompt>`.
 *
 * Constructor accepts {@link AdapterOptions} so the CLI layer can override
 * command and args from `~/.vesper/config.json`.
 */
export class OpenCodeAdapter extends BaseAdapter {
  readonly name = "opencode";
  protected readonly defaultCommand = "opencode";
  protected readonly defaultArgs: readonly string[] = ["run"];

  constructor(options: AdapterOptions = {}) {
    super(options);
  }
}
