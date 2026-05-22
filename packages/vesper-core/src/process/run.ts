import { VesperError } from "../errors.ts";

/** Options for {@link runProcess}. */
export interface RunOptions {
  /** Text written to the child's stdin, which is then closed. */
  readonly input?: string;
  /** Kill the child after this many milliseconds. Default 30_000. */
  readonly timeoutMs?: number;
}

/** Result of a finished child process. */
export interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
}

/**
 * The single shell-out seam in vesper-core. Vault and the CLI adapters both go
 * through this, so a test can inject a fake {@link ProcessRunner} and no real
 * process ever runs in a unit suite.
 */
export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options?: RunOptions,
) => Promise<RunResult>;

/** Raised when the command binary cannot be spawned (not installed / not on PATH). */
export class CommandNotFoundError extends VesperError {
  readonly command: string;

  constructor(command: string, options?: ErrorOptions) {
    super("process", `command not found: ${command}`, options);
    this.command = command;
  }
}

/** Raised when a command exceeds its timeout and is killed. */
export class ProcessTimeoutError extends VesperError {
  readonly command: string;
  readonly timeoutMs: number;

  constructor(command: string, timeoutMs: number) {
    super("process", `command timed out after ${timeoutMs}ms: ${command}`);
    this.command = command;
    this.timeoutMs = timeoutMs;
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Default {@link ProcessRunner}, backed by `Bun.spawn`. */
export const runProcess: ProcessRunner = async (command, args, options = {}) => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = performance.now();

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([command, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (cause) {
    // A missing binary throws synchronously from Bun.spawn.
    throw new CommandNotFoundError(command, { cause });
  }

  proc.stdin.write(options.input ?? "");
  proc.stdin.end();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (timedOut) {
      throw new ProcessTimeoutError(command, timeoutMs);
    }
    return { stdout, stderr, exitCode, durationMs: Math.round(performance.now() - start) };
  } finally {
    clearTimeout(timer);
  }
};
