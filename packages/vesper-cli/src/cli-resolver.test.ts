import { describe, expect, test } from "bun:test";
import { CLIError, type ProcessRunner, type RunResult } from "@vesper/core";
import { makeCompleteFn } from "./cli-resolver.ts";
import type { VesperConfig } from "./config.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function okResult(partial: Partial<RunResult> = {}): RunResult {
  return { stdout: "hello\n", stderr: "", exitCode: 0, durationMs: 5, ...partial };
}

/** A runner that records the command it was invoked with and returns a fixed result. */
function recordingRunner(result: RunResult = okResult()): {
  run: ProcessRunner;
  calls: { command: string; args: readonly string[] }[];
} {
  const calls: { command: string; args: readonly string[] }[] = [];
  const run: ProcessRunner = async (command, args) => {
    calls.push({ command, args });
    return result;
  };
  return { run, calls };
}

const emptyConfig: VesperConfig = { cli: { adapters: {} } };

// ---------------------------------------------------------------------------
// makeCompleteFn
// ---------------------------------------------------------------------------

describe("makeCompleteFn", () => {
  test("explicit override not in installed -> CLIError(not_installed), runner untouched", async () => {
    const { run, calls } = recordingRunner();
    const complete = makeCompleteFn({ cli: { default: "claude", adapters: {} } }, ["claude"], run);

    const err = await complete("hi", { cli: "codex" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CLIError);
    expect((err as CLIError).reason).toBe("not_installed");
    expect(calls).toHaveLength(0);
  });

  test("no override -> default resolves and the fake runner is invoked, text is trimmed stdout", async () => {
    const { run, calls } = recordingRunner(okResult({ stdout: "  the answer  \n" }));
    const complete = makeCompleteFn(emptyConfig, ["claude"], run);

    const result = await complete("ping");
    expect(result.text).toBe("the answer");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("claude");
  });

  test("installed override is used over the configured default", async () => {
    const { run, calls } = recordingRunner();
    // Default is claude, but the request overrides to codex (both installed).
    const complete = makeCompleteFn(
      { cli: { default: "claude", adapters: {} } },
      ["claude", "codex"],
      run,
    );

    await complete("ping", { cli: "codex" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("codex");
  });

  test("per-adapter config command override is honored", async () => {
    const { run, calls } = recordingRunner();
    const complete = makeCompleteFn(
      { cli: { default: "claude", adapters: { claude: { command: "claude-custom" } } } },
      ["claude"],
      run,
    );

    await complete("ping");
    expect(calls[0]?.command).toBe("claude-custom");
  });

  test("empty installed -> CLIError(not_installed)", async () => {
    const { run, calls } = recordingRunner();
    const complete = makeCompleteFn(emptyConfig, [], run);

    const err = await complete("hi").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CLIError);
    expect((err as CLIError).reason).toBe("not_installed");
    expect(calls).toHaveLength(0);
  });
});
