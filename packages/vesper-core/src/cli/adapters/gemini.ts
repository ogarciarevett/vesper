import { type AdapterOptions, BaseAdapter } from "./base.ts";

/**
 * Adapter for Google Gemini CLI (`gemini` binary). Runs prompts via
 * `gemini -p <prompt>`.
 *
 * Constructor accepts {@link AdapterOptions} so the CLI layer can override
 * command and args from `~/.vesper/config.json`.
 */
export class GeminiCLIAdapter extends BaseAdapter {
  readonly name = "gemini";
  protected readonly defaultCommand = "gemini";
  protected readonly defaultArgs: readonly string[] = ["-p"];

  constructor(options: AdapterOptions = {}) {
    super(options);
  }
}
