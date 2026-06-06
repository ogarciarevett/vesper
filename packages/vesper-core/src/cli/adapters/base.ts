import {
  CommandNotFoundError,
  type ProcessRunner,
  ProcessTimeoutError,
  runProcess,
} from "../../process/run.ts";
import { CLIError } from "../errors.ts";
import type { CLIAdapter, CompleteOptions, CompleteResult, CompleteUsage } from "../types.ts";

/** Auth-related patterns in stderr that indicate the user needs to log in. */
const AUTH_STDERR_RE = /not.*(authenticat|logged in|api key)|unauthorized|login/i;

/** Rate-limit / quota patterns — checked even on timeout from a CLI that retried internally. */
const RATE_LIMIT_STDERR_RE =
  /\b429\b|RESOURCE_EXHAUSTED|rate.?limit(?:ed)?|quota.{0,40}exhaust|too.{1,5}many.{1,5}requests/i;

/** Fixed prompt used by {@link BaseAdapter.probe} to verify liveness. */
const PROBE_PROMPT = "respond with the word OK";

/** Options accepted by every concrete adapter constructor. */
export interface AdapterOptions {
  /** Process seam; defaults to the real `runProcess`. Tests inject a fake here. */
  readonly run?: ProcessRunner;
  /** Override the default command binary name (e.g. `"claude"`). */
  readonly command?: string;
  /** Override the default base args (e.g. `["-p"]`). Prompt is appended after these. */
  readonly args?: readonly string[];
  /**
   * Override the base args used in AGENTIC mode ({@link CompleteOptions.agentic}).
   * Defaults to the adapter's {@link BaseAdapter.defaultAgenticArgs}. This is the knob
   * for granting the CLI the tool permissions an unattended browser task needs (e.g.
   * `--dangerously-skip-permissions` or `--allowedTools`); kept config-driven so Vesper
   * never bakes a permission posture into core.
   */
  readonly agenticArgs?: readonly string[];
}

/**
 * Base class shared by all four CLI adapters. Concrete subclasses only provide
 * `name`, `defaultCommand`, and `defaultArgs`; the `complete`/`probe` logic is here.
 *
 * Constructor accepts `AdapterOptions` so config-driven overrides of command and
 * base args flow through without each adapter reimplementing the wiring.
 */
export abstract class BaseAdapter implements CLIAdapter {
  abstract readonly name: string;

  protected abstract readonly defaultCommand: string;
  protected abstract readonly defaultArgs: readonly string[];

  readonly #run: ProcessRunner;
  readonly #command: string | undefined;
  readonly #args: readonly string[] | undefined;
  readonly #agenticArgs: readonly string[] | undefined;

  constructor(options: AdapterOptions = {}) {
    this.#run = options.run ?? runProcess;
    this.#command = options.command;
    this.#args = options.args;
    this.#agenticArgs = options.agenticArgs;
  }

  /**
   * Default base args for AGENTIC mode. Defaults to the one-shot {@link defaultArgs};
   * a subclass overrides this when its agentic invocation differs (see the claude
   * adapter). Config can override via {@link AdapterOptions.agenticArgs}.
   */
  protected get defaultAgenticArgs(): readonly string[] {
    return this.defaultArgs;
  }

  /** Resolved command: caller override, else the subclass default. */
  private get resolvedCommand(): string {
    return this.#command ?? this.defaultCommand;
  }

  /** Resolved base args: caller override, else the subclass default. */
  private get resolvedArgs(): readonly string[] {
    return this.#args ?? this.defaultArgs;
  }

  /** Resolved agentic args: caller override, else the subclass default agentic args. */
  private get resolvedAgenticArgs(): readonly string[] {
    return this.#agenticArgs ?? this.defaultAgenticArgs;
  }

  /**
   * Parse the raw stdout from a completed CLI process into a text string and
   * optional token usage. The default implementation returns the trimmed stdout
   * with no usage. Subclasses that emit machine-readable output (e.g. JSON)
   * override this to extract structured data; they MUST NOT throw — any parse
   * failure must fall back to `{ text: stdout.trim() }`.
   */
  protected parseOutput(stdout: string): { text: string; usage?: CompleteUsage } {
    return { text: stdout.trim() };
  }

  async complete(prompt: string, opts?: CompleteOptions): Promise<CompleteResult> {
    const baseArgs = opts?.agentic === true ? this.resolvedAgenticArgs : this.resolvedArgs;
    const argv = [...baseArgs, prompt];

    try {
      const res = await this.#run(this.resolvedCommand, argv, {
        timeoutMs: opts?.timeoutMs,
      });

      if (res.exitCode !== 0) {
        throw this.#mapNonzero(res.exitCode, res.stderr);
      }

      const parsed = this.parseOutput(res.stdout);

      return {
        text: parsed.text,
        exit_code: res.exitCode,
        raw_stdout: res.stdout,
        raw_stderr: res.stderr,
        duration_ms: res.durationMs,
        // Omit the key entirely when absent (exactOptionalPropertyTypes).
        ...(parsed.usage !== undefined ? { usage: parsed.usage } : {}),
      };
    } catch (err) {
      if (err instanceof CLIError) throw err;
      if (err instanceof CommandNotFoundError) {
        throw new CLIError("not_installed", `${this.resolvedCommand}: command not found`, {
          cause: err,
        });
      }
      if (err instanceof ProcessTimeoutError) {
        if (RATE_LIMIT_STDERR_RE.test(err.stderr)) {
          throw new CLIError(
            "rate_limited",
            `${this.resolvedCommand}: rate-limited (CLI retried until killed at ${err.timeoutMs}ms)`,
            { cause: err },
          );
        }
        throw new CLIError(
          "timeout",
          `${this.resolvedCommand}: timed out after ${err.timeoutMs}ms`,
          { cause: err },
        );
      }
      // Unknown error — re-throw as-is (not our error to wrap).
      throw err;
    }
  }

  async probe(opts?: CompleteOptions): Promise<void> {
    // complete() already maps all error categories to CLIError; just let it throw.
    await this.complete(PROBE_PROMPT, opts);
  }

  async version(opts?: CompleteOptions): Promise<string> {
    try {
      const res = await this.#run(this.resolvedCommand, ["--version"], {
        timeoutMs: opts?.timeoutMs ?? 3000,
      });
      if (res.exitCode !== 0) {
        throw new CLIError(
          "nonzero_exit",
          `${this.resolvedCommand} --version: exited with code ${res.exitCode}`,
        );
      }
      const first = res.stdout.split("\n", 1)[0] ?? "";
      return first.trim();
    } catch (err) {
      if (err instanceof CLIError) throw err;
      if (err instanceof CommandNotFoundError) {
        throw new CLIError("not_installed", `${this.resolvedCommand}: command not found`, {
          cause: err,
        });
      }
      if (err instanceof ProcessTimeoutError) {
        throw new CLIError(
          "timeout",
          `${this.resolvedCommand} --version: timed out after ${err.timeoutMs}ms`,
          { cause: err },
        );
      }
      throw err;
    }
  }

  #mapNonzero(exitCode: number, stderr: string): CLIError {
    if (RATE_LIMIT_STDERR_RE.test(stderr)) {
      return new CLIError(
        "rate_limited",
        `${this.resolvedCommand}: rate-limited (exit ${exitCode}): ${stderr.trim().slice(0, 200)}`,
      );
    }
    if (AUTH_STDERR_RE.test(stderr)) {
      return new CLIError(
        "not_authenticated",
        `${this.resolvedCommand}: not authenticated (exit ${exitCode}): ${stderr.trim()}`,
      );
    }
    return new CLIError(
      "nonzero_exit",
      `${this.resolvedCommand}: exited with code ${exitCode}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
    );
  }
}
