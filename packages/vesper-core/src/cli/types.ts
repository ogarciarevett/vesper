/** Token usage reported by a CLI completion, when the CLI emits it. All counts are tokens. */
export interface CompleteUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
  /** Model id the CLI reported, if any (used downstream to pick the context window). */
  readonly model?: string | null;
  /**
   * The model's exact context-window size (tokens), when the CLI reports it (e.g.
   * Claude's `modelUsage[model].contextWindow`). Preferred over the model-name
   * heuristic so the fill percentage is exact rather than guessed.
   */
  readonly contextWindow?: number;
}

/**
 * The result of a single `CLIAdapter.complete` call. All fields are populated
 * even on success so callers can log the raw output and timing without having
 * to track them separately.
 */
export interface CompleteResult {
  /** Trimmed stdout from the CLI process. */
  readonly text: string;
  /** Process exit code (0 on success). */
  readonly exit_code: number;
  /** Raw, untrimmed stdout. */
  readonly raw_stdout: string;
  /** Raw stderr (may be empty). */
  readonly raw_stderr: string;
  /** Wall-clock milliseconds from spawn to exit. */
  readonly duration_ms: number;
  /** Token usage from the CLI, if the adapter was able to parse it. */
  readonly usage?: CompleteUsage;
  /** Name of the adapter that served this completion (e.g. "claude"). */
  readonly cli?: string;
  /**
   * Resolved model for this call: the explicitly requested flag value when
   * {@link CompleteOptions.model} was set, else the model the CLI reported in its
   * usage envelope, else absent.
   */
  readonly model?: string;
}

/**
 * A single CLI backend that Vesper can shell out to. Each implementation wraps
 * one external binary (`claude`, `opencode`, `codex`, `gemini`). The interface
 * is intentionally minimal: one completion call and a health probe. Streaming,
 * tool-use, and cost tracking are out of scope for Foundation.
 *
 * Implementations MUST use an injectable {@link import("../process/run.ts").ProcessRunner}
 * so tests can mock the shell-out — no real process is invoked in a unit suite.
 */
export interface CLIAdapter {
  /** Machine-readable name of the underlying CLI (e.g. `"claude"`, `"gemini"`). */
  readonly name: string;

  /**
   * Run the CLI with `prompt` as the final positional argument and return the
   * result. Rejects with `CLIError` on failure.
   */
  complete(prompt: string, opts?: CompleteOptions): Promise<CompleteResult>;

  /**
   * Verify the CLI is installed AND working by sending a no-op prompt. Resolves on
   * success, rejects with `CLIError` on any failure (`not_installed`,
   * `not_authenticated`, `rate_limited`, `timeout`, `nonzero_exit`). Pass
   * `opts.timeoutMs` to tighten the timeout for listing/UX paths.
   */
  probe(opts?: CompleteOptions): Promise<void>;

  /**
   * Run `<command> --version` and return the first line of stdout (trimmed). Fast,
   * never hits the model, so callers can use this for "is it installed?" without
   * touching auth or quota. Rejects with `CLIError` on failure.
   */
  version(opts?: CompleteOptions): Promise<string>;
}

/**
 * Per-call options for {@link CLIAdapter.complete}.
 */
export interface CompleteOptions {
  /** Override the adapter's default timeout for this specific call (milliseconds). */
  readonly timeoutMs?: number;
  /**
   * Run the CLI in AGENTIC mode: let it use its own tools across a multi-step turn
   * (e.g. the agent-browser skill that sets up a messaging channel), invoking the
   * adapter's AGENTIC args instead of the one-shot completion args. The brain is still
   * the user's CLI — Vesper adds no LLM SDK and no browser dependency (Hard rule 12).
   * Pair with a generous {@link timeoutMs}: agentic tasks run for minutes, and the
   * 30s process default will abort them.
   */
  readonly agentic?: boolean;
  /**
   * Model FLAG VALUE for this call, inserted via the adapter's model flag (e.g.
   * `--model <value>`). This is the already-resolved per-CLI value — canonical
   * catalog ids are translated by the host resolver BEFORE reaching the adapter.
   */
  readonly model?: string;
}
