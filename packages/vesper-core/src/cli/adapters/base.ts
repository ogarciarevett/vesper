import {
  CommandNotFoundError,
  type ProcessRunner,
  ProcessTimeoutError,
  runProcess,
} from "../../process/run.ts";
import { CLIError } from "../errors.ts";
import type { CLIAdapter, CompleteOptions, CompleteResult } from "../types.ts";

/** Auth-related patterns in stderr that indicate the user needs to log in. */
const AUTH_STDERR_RE = /not.*(authenticat|logged in|api key)|unauthorized|login/i;

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

  constructor(options: AdapterOptions = {}) {
    this.#run = options.run ?? runProcess;
    this.#command = options.command;
    this.#args = options.args;
  }

  /** Resolved command: caller override, else the subclass default. */
  private get resolvedCommand(): string {
    return this.#command ?? this.defaultCommand;
  }

  /** Resolved base args: caller override, else the subclass default. */
  private get resolvedArgs(): readonly string[] {
    return this.#args ?? this.defaultArgs;
  }

  async complete(prompt: string, opts?: CompleteOptions): Promise<CompleteResult> {
    const argv = [...this.resolvedArgs, prompt];

    try {
      const res = await this.#run(this.resolvedCommand, argv, {
        timeoutMs: opts?.timeoutMs,
      });

      if (res.exitCode !== 0) {
        throw this.#mapNonzero(res.exitCode, res.stderr);
      }

      return {
        text: res.stdout.trim(),
        exit_code: res.exitCode,
        raw_stdout: res.stdout,
        raw_stderr: res.stderr,
        duration_ms: res.durationMs,
      };
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
          `${this.resolvedCommand}: timed out after ${err.timeoutMs}ms`,
          { cause: err },
        );
      }
      // Unknown error — re-throw as-is (not our error to wrap).
      throw err;
    }
  }

  async probe(): Promise<void> {
    // complete() already maps all error categories to CLIError; just let it throw.
    await this.complete(PROBE_PROMPT);
  }

  #mapNonzero(exitCode: number, stderr: string): CLIError {
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
