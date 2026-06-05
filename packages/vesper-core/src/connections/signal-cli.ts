/**
 * The `signal-cli` process seam — Vesper's only coupling to the external Signal
 * client. Signal has no hosted API and no npm SDK; it is reached through the local
 * `signal-cli` binary the user installs, exactly as the LLM CLI adapters shell out
 * to `claude`/`codex`. So this stays a thin, INJECTED wrapper over the process
 * layer: `probe`/`send` ride the batch {@link ProcessRunner} seam, and `link`
 * (which must stream a device-link URI WHILE the process blocks awaiting a scan)
 * rides a small {@link LinkSpawner} seam. Both default to `Bun.spawn`; the unit
 * suite injects fakes, so no real `signal-cli` ever runs.
 */

import { CommandNotFoundError, type ProcessRunner, runProcess } from "../process/run.ts";
import { ConnectionError } from "./errors.ts";

/** The binary name; on PATH after `brew install signal-cli` (or a distro package). */
const SIGNAL_CLI = "signal-cli";

/** An event parsed from `signal-cli link`'s streamed output. */
export type SignalLinkEvent =
  | { readonly kind: "uri"; readonly uri: string }
  | { readonly kind: "linked"; readonly account: string };

/** A running `signal-cli link` process, surfaced as merged output lines + a kill. */
export interface LinkProcess {
  /** Lines from the child's stdout+stderr, merged, as they arrive. */
  lines(): AsyncIterable<string>;
  /** Kill the child (idempotent). */
  kill(): void;
}

/** Spawns `signal-cli link -n <name>`; injected so tests stream canned lines. */
export type LinkSpawner = (name: string) => LinkProcess;

/** A running device-link attempt: events until linked/end, plus a stop handle. */
export interface SignalLinkSession {
  events(): AsyncIterable<SignalLinkEvent>;
  stop(): void;
}

/** The capabilities the Signal handler needs from `signal-cli`. */
export interface SignalCli {
  /** Verify signal-cli is installed AND `account` is linked. Throws otherwise. */
  probe(account: string): Promise<void>;
  /** Send a 1:1 text message to `recipient` from `account`. */
  send(account: string, recipient: string, text: string): Promise<void>;
  /** Begin device-link pairing; the session streams the URI then the linked account. */
  link(name: string): SignalLinkSession;
}

/**
 * Classify one line of `signal-cli link` output. The link command prints the
 * device-link URI (`sgnl://linkdevice?...`, or the legacy `tsdevice:/?...`) and,
 * on success, `Associated with: <account>`. Everything else is noise (undefined).
 */
export function parseSignalLinkLine(line: string): SignalLinkEvent | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  const uri = trimmed.match(/(?:sgnl:\/\/linkdevice|tsdevice:\/?)\S+/)?.[0];
  if (uri !== undefined) return { kind: "uri", uri };
  const associated = trimmed.match(/associated with:\s*(.+)/i)?.[1]?.trim();
  if (associated !== undefined && associated.length > 0) {
    return { kind: "linked", account: associated };
  }
  return undefined;
}

/** Map a stream of output lines to {@link SignalLinkEvent}s (pure; the testable core). */
export async function* linkEventsFromLines(
  lines: AsyncIterable<string>,
): AsyncGenerator<SignalLinkEvent> {
  for await (const line of lines) {
    const event = parseSignalLinkLine(line);
    if (event !== undefined) yield event;
  }
}

/** Yield newline-delimited lines from a byte stream as they arrive (trailing line flushed). */
export async function* streamLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        yield buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
      }
    }
    if (buffer.length > 0) yield buffer;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Merge several byte streams into one line stream, yielding each line as soon as
 * it arrives on any source. signal-cli prints the URI on stdout and may report the
 * association on stderr, so both are read concurrently.
 */
export async function* mergeStreamLines(
  streams: readonly ReadableStream<Uint8Array>[],
): AsyncGenerator<string> {
  const queue: string[] = [];
  let active = streams.length;
  let wake: (() => void) | null = null;
  const signal = (): void => {
    wake?.();
    wake = null;
  };
  for (const stream of streams) {
    void (async () => {
      for await (const line of streamLines(stream)) {
        queue.push(line);
        signal();
      }
    })()
      .catch(() => {})
      .finally(() => {
        active -= 1;
        signal();
      });
  }
  while (active > 0 || queue.length > 0) {
    if (queue.length === 0) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      continue;
    }
    const line = queue.shift();
    if (line !== undefined) yield line;
  }
}

/** Default {@link LinkSpawner}: a streaming `Bun.spawn` of `signal-cli link`. */
const defaultLinkSpawner: LinkSpawner = (name) => {
  const proc = Bun.spawn([SIGNAL_CLI, "link", "-n", name], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const stdout = proc.stdout as ReadableStream<Uint8Array>;
  const stderr = proc.stderr as ReadableStream<Uint8Array>;
  return {
    lines: () => mergeStreamLines([stdout, stderr]),
    kill: () => {
      try {
        proc.kill();
      } catch {
        // kill is best-effort and idempotent; a dead child must not throw.
      }
    },
  };
};

/** Construct the default {@link SignalCli}, with the process seams injectable for tests. */
export function makeSignalCli(
  deps: { readonly run?: ProcessRunner; readonly spawnLink?: LinkSpawner } = {},
): SignalCli {
  const run = deps.run ?? runProcess;
  const spawnLink = deps.spawnLink ?? defaultLinkSpawner;

  /** Run a signal-cli subcommand, mapping a missing binary to `not_installed`. */
  const exec = async (args: readonly string[]): Promise<{ stdout: string; exitCode: number }> => {
    try {
      const { stdout, exitCode } = await run(SIGNAL_CLI, args);
      return { stdout, exitCode };
    } catch (cause) {
      if (cause instanceof CommandNotFoundError) {
        throw new ConnectionError(
          "not_installed",
          "signal-cli is not installed — `brew install signal-cli` then pair again",
          { cause },
        );
      }
      throw cause;
    }
  };

  return {
    async probe(account) {
      const { stdout, exitCode } = await exec(["--output=json", "listAccounts"]);
      if (exitCode !== 0 || !stdout.includes(account)) {
        throw new ConnectionError(
          "not_authenticated",
          `signal-cli has no linked account ${account} — pair it first`,
        );
      }
    },
    async send(account, recipient, text) {
      const { exitCode } = await exec(["-a", account, "-o", "json", "send", "-m", text, recipient]);
      if (exitCode !== 0) {
        throw new ConnectionError("send_failed", `signal-cli send exited ${exitCode}`);
      }
    },
    link(name) {
      const proc = spawnLink(name);
      return {
        events: () => linkEventsFromLines(proc.lines()),
        stop: () => proc.kill(),
      };
    },
  };
}
