import { describe, expect, test } from "bun:test";
import type { ProcessRunner, RunResult } from "../process/run.ts";
import { parsePsOutput, psProcessLister } from "./lister.ts";
import { PresenceError } from "./types.ts";

const ok = (stdout: string): RunResult => ({ stdout, stderr: "", exitCode: 0, durationMs: 1 });

describe("parsePsOutput", () => {
  test("parses pid, etime, and space-containing args", () => {
    const out = [
      "45702    02:15:03 /Applications/Claude.app/Contents/MacOS/Claude",
      "12536       01:02 node /Users/me/.bun/bin/claude --resume",
    ].join("\n");
    expect(parsePsOutput(out)).toEqual([
      { pid: 45702, etime: "02:15:03", args: "/Applications/Claude.app/Contents/MacOS/Claude" },
      { pid: 12536, etime: "01:02", args: "node /Users/me/.bun/bin/claude --resume" },
    ]);
  });

  test("skips blank and malformed lines", () => {
    expect(parsePsOutput("\n   \nnot-a-process-line\n42 00:01 sleep 1\n")).toEqual([
      { pid: 42, etime: "00:01", args: "sleep 1" },
    ]);
  });
});

describe("psProcessLister", () => {
  test("returns parsed rows from the runner", async () => {
    const runner: ProcessRunner = async () => ok("7 00:09 /usr/sbin/cupsd -l");
    const rows = await psProcessLister(runner).list();
    expect(rows).toEqual([{ pid: 7, etime: "00:09", args: "/usr/sbin/cupsd -l" }]);
  });

  test("throws PresenceError(ps_unavailable) on a non-zero exit", async () => {
    const runner: ProcessRunner = async () => ({
      stdout: "",
      stderr: "boom",
      exitCode: 1,
      durationMs: 1,
    });
    const err = await psProcessLister(runner)
      .list()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PresenceError);
    expect((err as PresenceError).reason).toBe("ps_unavailable");
  });

  test("throws PresenceError(ps_unavailable) when ps cannot be spawned", async () => {
    const runner: ProcessRunner = async () => {
      throw new Error("ENOENT");
    };
    const err = await psProcessLister(runner)
      .list()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PresenceError);
    expect((err as PresenceError).reason).toBe("ps_unavailable");
  });
});
