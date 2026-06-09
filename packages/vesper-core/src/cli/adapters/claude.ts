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
 * Resolve the model id AND its exact context window from a Claude JSON envelope.
 *
 * Model preference: top-level `model` string, else the first `modelUsage` key (the
 * model id Anthropic uses internally), else `null`. The window comes from that same
 * `modelUsage` entry's `contextWindow` (a real number from the CLI) when present —
 * preferred downstream over the model-name heuristic so the fill is exact.
 */
function resolveModelInfo(envelope: ClaudeJsonEnvelope): {
  model: string | null;
  contextWindow?: number;
} {
  const usage = envelope.modelUsage;
  const firstKey = typeof usage === "object" && usage !== null ? Object.keys(usage)[0] : undefined;

  const model = typeof envelope.model === "string" ? envelope.model : (firstKey ?? null);

  if (firstKey !== undefined && usage !== undefined) {
    const entry = usage[firstKey];
    const cw =
      typeof entry === "object" && entry !== null
        ? (entry as Record<string, unknown>).contextWindow
        : undefined;
    if (typeof cw === "number" && cw > 0) return { model, contextWindow: cw };
  }
  return { model };
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
/** Narrow an `unknown` to a plain object record. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class ClaudeCodeAdapter extends BaseAdapter {
  readonly name = "claude";
  protected readonly defaultCommand = "claude";
  protected readonly defaultArgs: readonly string[] = ["-p", "--output-format", "json"];

  constructor(options: AdapterOptions = {}) {
    super(options);
  }

  /**
   * Streaming mode: `--output-format stream-json` emits NDJSON (one event per
   * line; `--verbose` is required in print mode, `--include-partial-messages`
   * adds the `stream_event` deltas). The chunk handler buffers partial lines
   * across chunks and forwards ONLY `text_delta` payloads; the final
   * `type:"result"` line is what {@link parseOutput} reads from the buffered
   * stdout, so the result is identical to the non-streaming call.
   */
  protected override streamMode(onText: (delta: string) => void): {
    readonly args?: readonly string[];
    readonly onChunk: (chunk: string) => void;
  } {
    let buffer = "";
    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // Not NDJSON (old CLI / overridden args) — pass the raw line through so
        // the caller still streams SOMETHING rather than nothing.
        onText(trimmed);
        return;
      }
      if (!isRecord(parsed) || parsed.type !== "stream_event") return;
      const event = parsed.event;
      if (!isRecord(event) || event.type !== "content_block_delta") return;
      const delta = event.delta;
      if (isRecord(delta) && delta.type === "text_delta" && typeof delta.text === "string") {
        onText(delta.text);
      }
    };
    return {
      args: ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"],
      onChunk: (chunk) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) handleLine(line);
      },
    };
  }

  /**
   * Extract text + usage from a parsed result envelope, or undefined when the
   * value is not a `result` envelope with a string `result`.
   */
  #parseEnvelope(raw: unknown): { text: string; usage?: CompleteUsage } | undefined {
    if (!isClaudeJsonEnvelope(raw) || typeof raw.result !== "string") return undefined;

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
    const { model, contextWindow } = resolveModelInfo(raw);
    const usage: CompleteUsage = {
      inputTokens,
      outputTokens,
      model,
      ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
      ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
    };

    return { text: raw.result, usage };
  }

  protected override parseOutput(stdout: string): { text: string; usage?: CompleteUsage } {
    // One JSON document: the `--output-format json` envelope.
    try {
      const envelope = this.#parseEnvelope(JSON.parse(stdout));
      if (envelope !== undefined) return envelope;
      return { text: stdout.trim() };
    } catch {
      // Not a single document — try NDJSON (stream-json mode): the LAST line that
      // parses to a result envelope carries the same shape as the json mode.
      for (const line of stdout.split("\n").reverse()) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          const parsed: unknown = JSON.parse(trimmed);
          if (isRecord(parsed) && parsed.type === "result") {
            const envelope = this.#parseEnvelope(parsed);
            if (envelope !== undefined) return envelope;
          }
        } catch {
          // skip non-JSON lines
        }
      }
      // Plain text (old claude version, test stub, etc.).
      return { text: stdout.trim() };
    }
  }
}
