import { describe, expect, test } from "bun:test";
import { CommandNotFoundError, type ProcessRunner, type RunResult } from "../process/run.ts";
import { ConnectionError } from "./errors.ts";
import {
  type LinkProcess,
  linkEventsFromLines,
  makeSignalCli,
  mergeStreamLines,
  parseSignalLinkLine,
  type SignalLinkEvent,
  streamLines,
} from "./signal-cli.ts";

function result(over: Partial<RunResult> = {}): RunResult {
  return { stdout: "", stderr: "", exitCode: 0, durationMs: 1, ...over };
}

/** A recording fake ProcessRunner. */
function fakeRunner(out: RunResult | (() => never)): {
  run: ProcessRunner;
  calls: { command: string; args: readonly string[] }[];
} {
  const calls: { command: string; args: readonly string[] }[] = [];
  const run: ProcessRunner = async (command, args) => {
    calls.push({ command, args });
    if (typeof out === "function") return out();
    return out;
  };
  return { run, calls };
}

function streamFromChunks(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
      controller.close();
    },
  });
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

describe("parseSignalLinkLine", () => {
  test("recognizes the sgnl device-link URI", () => {
    expect(parseSignalLinkLine("sgnl://linkdevice?uuid=abc&pub_key=def")).toEqual({
      kind: "uri",
      uri: "sgnl://linkdevice?uuid=abc&pub_key=def",
    });
  });

  test("recognizes the legacy tsdevice URI", () => {
    expect(parseSignalLinkLine("tsdevice:/?uuid=x&pub_key=y")?.kind).toBe("uri");
  });

  test("recognizes the association line and captures the account", () => {
    expect(parseSignalLinkLine("Associated with: +15551234567")).toEqual({
      kind: "linked",
      account: "+15551234567",
    });
  });

  test("ignores noise and blank lines", () => {
    expect(parseSignalLinkLine("")).toBeUndefined();
    expect(parseSignalLinkLine("Scan this QR code with your phone")).toBeUndefined();
  });
});

describe("linkEventsFromLines", () => {
  test("maps a line stream to events, dropping noise", async () => {
    async function* lines(): AsyncGenerator<string> {
      yield "starting link";
      yield "sgnl://linkdevice?uuid=a&pub_key=b";
      yield "waiting...";
      yield "Associated with: +15550001111";
    }
    const events = await collect(linkEventsFromLines(lines()));
    expect(events).toEqual([
      { kind: "uri", uri: "sgnl://linkdevice?uuid=a&pub_key=b" },
      { kind: "linked", account: "+15550001111" },
    ]);
  });
});

describe("streamLines", () => {
  test("splits across chunk boundaries and flushes a trailing line", async () => {
    const stream = streamFromChunks(["one\ntw", "o\nthree"]);
    expect(await collect(streamLines(stream))).toEqual(["one", "two", "three"]);
  });
});

describe("mergeStreamLines", () => {
  test("yields every line from all sources", async () => {
    const a = streamFromChunks(["a1\na2\n"]);
    const b = streamFromChunks(["b1\n"]);
    const merged = await collect(mergeStreamLines([a, b]));
    expect(merged.sort()).toEqual(["a1", "a2", "b1"]);
  });
});

describe("makeSignalCli.probe", () => {
  test("succeeds when listAccounts contains the account", async () => {
    const { run, calls } = fakeRunner(result({ stdout: '[{"number":"+15551234567"}]' }));
    await makeSignalCli({ run }).probe("+15551234567");
    expect(calls[0]).toEqual({ command: "signal-cli", args: ["--output=json", "listAccounts"] });
  });

  test("throws not_authenticated when the account is absent", async () => {
    const { run } = fakeRunner(result({ stdout: "[]" }));
    await expect(makeSignalCli({ run }).probe("+15551234567")).rejects.toMatchObject({
      reason: "not_authenticated",
    });
  });

  test("throws not_installed when the binary is missing", async () => {
    const { run } = fakeRunner(() => {
      throw new CommandNotFoundError("signal-cli");
    });
    const error = await makeSignalCli({ run })
      .probe("+1")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as ConnectionError).reason).toBe("not_installed");
  });
});

describe("makeSignalCli.send", () => {
  test("invokes signal-cli send with body+recipient as discrete argv", async () => {
    const { run, calls } = fakeRunner(result());
    await makeSignalCli({ run }).send("+1555", "+1999", "hello there");
    expect(calls[0]?.args).toEqual([
      "-a",
      "+1555",
      "-o",
      "json",
      "send",
      "-m",
      "hello there",
      "+1999",
    ]);
  });

  test("throws send_failed on a nonzero exit", async () => {
    const { run } = fakeRunner(result({ exitCode: 1, stderr: "boom" }));
    await expect(makeSignalCli({ run }).send("+1", "+2", "x")).rejects.toMatchObject({
      reason: "send_failed",
    });
  });
});

describe("makeSignalCli.link", () => {
  test("streams parsed events and stop() kills the child", async () => {
    let killed = false;
    const spawnLink = (name: string): LinkProcess => {
      expect(name).toBe("Vesper");
      return {
        async *lines() {
          yield "sgnl://linkdevice?uuid=a&pub_key=b";
          yield "Associated with: +15557654321";
        },
        kill() {
          killed = true;
        },
      };
    };
    const session = makeSignalCli({ spawnLink }).link("Vesper");
    const events: SignalLinkEvent[] = await collect(session.events());
    expect(events).toEqual([
      { kind: "uri", uri: "sgnl://linkdevice?uuid=a&pub_key=b" },
      { kind: "linked", account: "+15557654321" },
    ]);
    session.stop();
    expect(killed).toBe(true);
  });
});
