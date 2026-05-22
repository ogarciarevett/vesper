import type { AdapterOptions } from "./adapters/base.ts";
import { ClaudeCodeAdapter } from "./adapters/claude.ts";
import { CodexAdapter } from "./adapters/codex.ts";
import { GeminiCLIAdapter } from "./adapters/gemini.ts";
import { OpenCodeAdapter } from "./adapters/opencode.ts";
import type { CLIAdapter } from "./types.ts";

/** A function that constructs a {@link CLIAdapter} given optional overrides. */
export type AdapterFactory = (options?: AdapterOptions) => CLIAdapter;

/**
 * Maps each known adapter name to its constructor function. The CLI layer
 * uses this to build an adapter by name from `~/.vesper/config.json` without
 * importing every adapter directly.
 *
 * Read-only so callers cannot mutate the registry; new adapters must be added
 * here at build time.
 */
export const ADAPTER_REGISTRY: Readonly<Record<string, AdapterFactory>> = {
  claude: (opts) => new ClaudeCodeAdapter(opts),
  opencode: (opts) => new OpenCodeAdapter(opts),
  codex: (opts) => new CodexAdapter(opts),
  gemini: (opts) => new GeminiCLIAdapter(opts),
};

/**
 * Build a {@link CLIAdapter} by name from the registry.
 *
 * @returns The adapter instance, or `undefined` if `name` is not registered.
 */
export function buildAdapter(name: string, options?: AdapterOptions): CLIAdapter | undefined {
  const factory = ADAPTER_REGISTRY[name];
  return factory !== undefined ? factory(options) : undefined;
}
