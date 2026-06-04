import type { CompleteUsage } from "../types.ts";
import { type AdapterOptions, BaseAdapter } from "./base.ts";

/**
 * Shape of the JSON envelope emitted by `claude -p --output-format json`.
 * Typed as `unknown` at the call site; we narrow it with type guards.
 */
interface ClaudeJsonEnvelope {
  readonly type?: unknown;
  readonly result?: unknown;
  readonly usage?: {
    readonly input_tokens?: unknown;
    readonly output_tokens?: unknown;
    readonly cache_read_input_tokens?: unknown;
    readonly cache_creation_input_tokens?: unknown;
  };
  readonly model?: unknown;
  readonly modelUsage?: Record<string, unknown>;
}

function isClaudeJsonEnvelope(v: unknown): v is ClaudeJsonEnvelope {
  return typeof v === "object" && v !== null;
}

function toNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/**
 * Resolve the model identifier from a Claude JSON envelope. Preference order:
 * 1. Top-level `model` string field.
 * 2. First key of `modelUsage` object (the model id Anthropic uses internally).
 * 3. `null` — present but unresolvable.
 */
function resolveModel(envelope: ClaudeJsonEnvelope): string | null {
  if (typeof envelope.model === "string") return envelope.model;
  if (typeof envelope.modelUsage === "object" && envelope.modelUsage !== null) {
    const firstKey = Object.keys(envelope.modelUsage)[0];
    if (firstKey !== undefined) return firstKey;
  }
  return null;
}

/**
 * Adapter for Claude Code (`claude` CLI). Runs prompts via
 * `claude -p --output-format json <prompt>`, which produces a JSON envelope
 * containing both the assistant's reply and token-usage statistics.
 *
 * If the stdout is not a valid JSON envelope (e.g. the user has an older
 * `claude` version or overrode args), `parseOutput` falls back to returning the
 * raw trimmed text with no usage — so the completion always succeeds.
 *
 * Constructor accepts {@link AdapterOptions} so the CLI layer can override
 * command and args from `~/.vesper/config.json`.
 */
export class ClaudeCodeAdapter extends BaseAdapter {
  readonly name = "claude";
  protected readonly defaultCommand = "claude";
  protected readonly defaultArgs: readonly string[] = ["-p", "--output-format", "json"];

  constructor(options: AdapterOptions = {}) {
    super(options);
  }

  protected override parseOutput(stdout: string): { text: string; usage?: CompleteUsage } {
    try {
      const raw: unknown = JSON.parse(stdout);

      if (!isClaudeJsonEnvelope(raw)) {
        return { text: stdout.trim() };
      }

      if (typeof raw.result !== "string") {
        // Not a result envelope (could be a different JSON shape) — fall back.
        return { text: stdout.trim() };
      }

      const u = raw.usage;
      const inputTokens = toNumber(u?.input_tokens);
      const outputTokens = toNumber(u?.output_tokens);

      // Only produce usage when the required token fields are present.
      if (inputTokens === undefined || outputTokens === undefined) {
        return { text: raw.result };
      }
      // Include the optional cache fields only when present (exactOptionalPropertyTypes).
      const cacheReadTokens = toNumber(u?.cache_read_input_tokens);
      const cacheCreationTokens = toNumber(u?.cache_creation_input_tokens);
      const usage: CompleteUsage = {
        inputTokens,
        outputTokens,
        model: resolveModel(raw),
        ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
        ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
      };

      return { text: raw.result, usage };
    } catch {
      // JSON.parse threw — stdout is plain text (old claude version, test stub, etc.).
      return { text: stdout.trim() };
    }
  }
}
