import { type AdapterOptions, BaseAdapter } from "./base.ts";

/**
 * Adapter for OpenAI Codex CLI (`codex` binary). Runs prompts via
 * `codex exec <prompt>`.
 *
 * Constructor accepts {@link AdapterOptions} so the CLI layer can override
 * command and args from `~/.vesper/config.json`.
 */
export class CodexAdapter extends BaseAdapter {
  readonly name = "codex";
  protected readonly defaultCommand = "codex";
  protected readonly defaultArgs: readonly string[] = ["exec"];

  constructor(options: AdapterOptions = {}) {
    super(options);
  }
}
