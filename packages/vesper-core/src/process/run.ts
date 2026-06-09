import { VesperError } from "../errors.ts";

/** Options for {@link runProcess}. */
export interface RunOptions {
  /** Text written to the child's stdin, which is then closed. */
  readonly input?: string;
  /** Kill the child after this many milliseconds. Default 30_000. */
  readonly timeoutMs?: number;
  /**
   * Called with each stdout chunk AS IT ARRIVES (decoded text). The final
   * {@link RunResult.stdout} is unchanged — the same full text, buffered. A
   * throwing listener never affects the run.
   */
  readonly onStdout?: (chunk: string) => void;
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
  /** Whatever the child wrote to stdout before it was killed (may be empty). */
  readonly stdout: string;
  /** Whatever the child wrote to stderr before it was killed (may be empty). */
  readonly stderr: string;

  constructor(
    command: string,
    timeoutMs: number,
    partial: { stdout: string; stderr: string } = { stdout: "", stderr: "" },
  ) {
    super("process", `command timed out after ${timeoutMs}ms: ${command}`);
    this.command = command;
    this.timeoutMs = timeoutMs;
    this.stdout = partial.stdout;
    this.stderr = partial.stderr;
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

  // Incremental stdout: only when a listener is attached — the buffered
  // fast-path stays byte-identical for every existing caller.
  const readStdout = async (): Promise<string> => {
    const onStdout = options.onStdout;
    // The instanceof check narrows Bun.spawn's loose stdout union; with "pipe"
    // it is always a ReadableStream, so the buffered path below is unreachable
    // in practice when a listener is attached.
    const stdout = proc.stdout;
    if (onStdout === undefined || !(stdout instanceof ReadableStream)) {
      return new Response(proc.stdout).text();
    }
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      if (chunk.length === 0) continue;
      out += chunk;
      try {
        onStdout(chunk);
      } catch {
        // A listener error must never affect the process result.
      }
    }
    out += decoder.decode();
    return out;
  };

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readStdout(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (timedOut) {
      throw new ProcessTimeoutError(command, timeoutMs, { stdout, stderr });
    }
    return { stdout, stderr, exitCode, durationMs: Math.round(performance.now() - start) };
  } finally {
    clearTimeout(timer);
  }
};
