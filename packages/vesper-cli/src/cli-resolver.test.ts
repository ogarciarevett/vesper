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

// ---------------------------------------------------------------------------
// Model routing (specs/orchestrator-home.md slice A)
// ---------------------------------------------------------------------------

describe("makeCompleteFn model routing", () => {
  test("a catalog model picks BOTH the adapter and the flag value", async () => {
    const { run, calls } = recordingRunner();
    // Built-in catalog: "claude-haiku" -> { cli: "claude", flag: "haiku" }.
    const complete = makeCompleteFn(
      { cli: { default: "codex", adapters: {} } },
      ["claude", "codex"],
      run,
    );

    await complete("hi", { model: "claude-haiku" });
    expect(calls[0]?.command).toBe("claude"); // catalog wins over the codex default
    const at = calls[0]?.args.indexOf("--model") ?? -1;
    expect(calls[0]?.args[at + 1]).toBe("haiku");
  });

  test("an unknown model id passes through verbatim to the resolved adapter", async () => {
    const { run, calls } = recordingRunner();
    const complete = makeCompleteFn({ cli: { default: "claude", adapters: {} } }, ["claude"], run);

    await complete("hi", { model: "some-custom-model" });
    expect(calls[0]?.command).toBe("claude");
    const at = calls[0]?.args.indexOf("--model") ?? -1;
    expect(calls[0]?.args[at + 1]).toBe("some-custom-model");
  });

  test("a raw directory-style id routes to its provider's CLI by shape", async () => {
    const { run, calls } = recordingRunner();
    // Default is claude, but "gemini-3.5-pro" is not a catalog id — shape wins.
    const complete = makeCompleteFn(
      { cli: { default: "claude", adapters: {} } },
      ["claude", "gemini"],
      run,
    );

    await complete("hi", { model: "gemini-3.5-pro" });
    expect(calls[0]?.command).toBe("gemini");
    const at = calls[0]?.args.indexOf("--model") ?? calls[0]?.args.indexOf("-m") ?? -1;
    expect(calls[0]?.args[at + 1]).toBe("gemini-3.5-pro");
  });

  test("a raw id whose inferred CLI is not installed is dropped (no flag, default adapter)", async () => {
    const { run, calls } = recordingRunner();
    const complete = makeCompleteFn({ cli: { default: "claude", adapters: {} } }, ["claude"], run);

    await complete("hi", { model: "gpt-5.5-pro" });
    expect(calls[0]?.command).toBe("claude");
    expect(calls[0]?.args).not.toContain("--model");
  });

  test("an explicit cli override is never second-guessed by shape inference", async () => {
    const { run, calls } = recordingRunner();
    const complete = makeCompleteFn(emptyConfig, ["claude", "opencode"], run);

    // opencode can serve claude models; the claude-shaped id must NOT conflict.
    await complete("hi", { cli: "opencode", model: "claude-opus-4-8" });
    expect(calls[0]?.command).toBe("opencode");
  });

  test("a catalog model whose CLI is not installed is dropped (no model flag, default adapter)", async () => {
    const { run, calls } = recordingRunner();
    // "gpt" maps to codex, which is NOT installed -> fall back to claude, no flag.
    const complete = makeCompleteFn({ cli: { default: "claude", adapters: {} } }, ["claude"], run);

    const result = await complete("hi", { model: "gpt" });
    expect(calls[0]?.command).toBe("claude");
    expect(calls[0]?.args).not.toContain("--model");
    expect(result.cli).toBe("claude");
  });

  test("a conflicting explicit cli + catalog model is a CLIError", async () => {
    const { run, calls } = recordingRunner();
    const complete = makeCompleteFn(emptyConfig, ["claude", "codex"], run);

    const err = await complete("hi", { cli: "codex", model: "claude-haiku" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CLIError);
    expect(calls).toHaveLength(0);
  });

  test("config catalog entries override built-ins per key", async () => {
    const { run, calls } = recordingRunner();
    const config: VesperConfig = {
      cli: { default: "claude", adapters: {} },
      models: { catalog: { "claude-haiku": { cli: "claude", flag: "haiku-next", tier: "cheap" } } },
    };
    const complete = makeCompleteFn(config, ["claude"], run);

    await complete("hi", { model: "claude-haiku" });
    const at = calls[0]?.args.indexOf("--model") ?? -1;
    expect(calls[0]?.args[at + 1]).toBe("haiku-next");
  });

  test("timeoutMs is forwarded to the process runner", async () => {
    let captured: number | undefined;
    const run: ProcessRunner = async (_cmd, _args, options) => {
      captured = options?.timeoutMs;
      return okResult();
    };
    const complete = makeCompleteFn(emptyConfig, ["claude"], run);

    await complete("hi", { timeoutMs: 123_456 });
    expect(captured).toBe(123_456);
  });
});
