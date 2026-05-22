export type { AdapterOptions } from "./adapters/base.ts";
export { ClaudeCodeAdapter } from "./adapters/claude.ts";
export { CodexAdapter } from "./adapters/codex.ts";
export { GeminiCLIAdapter } from "./adapters/gemini.ts";
export { OpenCodeAdapter } from "./adapters/opencode.ts";
export { type AdapterName, detectAvailableCLIs, selectDefault } from "./detect.ts";
export { CLIError, type CLIErrorReason } from "./errors.ts";
export { ADAPTER_REGISTRY, type AdapterFactory, buildAdapter } from "./registry.ts";
export type { CLIAdapter, CompleteOptions, CompleteResult } from "./types.ts";
