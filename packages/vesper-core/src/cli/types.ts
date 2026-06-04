/** Token usage reported by a CLI completion, when the CLI emits it. All counts are tokens. */
export interface CompleteUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
  /** Model id the CLI reported, if any (used downstream to pick the context window). */
  readonly model?: string | null;
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
 * Per-call options for {@link CLIAdapter.complete}. Foundation only exposes the
 * timeout override; additional options (max_tokens, temperature) land later.
 */
export interface CompleteOptions {
  /** Override the adapter's default timeout for this specific call (milliseconds). */
  readonly timeoutMs?: number;
}
