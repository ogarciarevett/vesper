import { describe, expect, test } from "bun:test";
import type { ProcessRunner, RunResult } from "../process/run.ts";
import { CommandNotFoundError, ProcessTimeoutError } from "../process/run.ts";
import { ClaudeCodeAdapter } from "./adapters/claude.ts";
import { CodexAdapter } from "./adapters/codex.ts";
import { GeminiCLIAdapter } from "./adapters/gemini.ts";
import { OpenCodeAdapter } from "./adapters/opencode.ts";
import { detectAvailableCLIs, selectDefault } from "./detect.ts";
import { CLIError } from "./errors.ts";
import { ADAPTER_REGISTRY, buildAdapter } from "./registry.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function okResult(partial: Partial<RunResult> = {}): RunResult {
  return { stdout: "hello\n", stderr: "", exitCode: 0, durationMs: 5, ...partial };
}

/** Returns a runner that always resolves with the given result. */
function fixedRunner(result: RunResult): ProcessRunner {
  return async () => result;
}

/** Returns a runner that always throws the given error. */
function throwingRunner(err: unknown): ProcessRunner {
  return async () => {
    throw err;
  };
}

// ---------------------------------------------------------------------------
// CLIError
// ---------------------------------------------------------------------------

describe("CLIError", () => {
  test("has code='cli' and the given reason", () => {
    const err = new CLIError("not_installed", "claude: command not found");
    expect(err.code).toBe("cli");
    expect(err.reason).toBe("not_installed");
    expect(err.name).toBe("CLIError");
  });

  test("carries cause when provided", () => {
    const cause = new Error("original");
    const err = new CLIError("timeout", "timed out", { cause });
    expect(err.cause).toBe(cause);
  });

  test("all reason variants are valid", () => {
    const reasons = ["not_installed", "not_authenticated", "timeout", "nonzero_exit"] as const;
    for (const reason of reasons) {
      const e = new CLIError(reason, "msg");
      expect(e.reason).toBe(reason);
    }
  });
});

// ---------------------------------------------------------------------------
// ClaudeCodeAdapter — complete()
// ---------------------------------------------------------------------------

describe("ClaudeCodeAdapter.complete", () => {
  test("returns CompleteResult on success", async () => {
    const adapter = new ClaudeCodeAdapter({ run: fixedRunner(okResult()) });
    const result = await adapter.complete("say hello");
    expect(result.text).toBe("hello");
    expect(result.exit_code).toBe(0);
    expect(result.raw_stdout).toBe("hello\n");
    expect(result.raw_stderr).toBe("");
    expect(typeof result.duration_ms).toBe("number");
  });

  test("text is trimmed stdout", async () => {
    const adapter = new ClaudeCodeAdapter({
      run: fixedRunner(okResult({ stdout: "  output with spaces  \n" })),
    });
    const result = await adapter.complete("test");
    expect(result.text).toBe("output with spaces");
  });

  test("passes prompt as the last arg", async () => {
    let capturedArgs: readonly string[] = [];
    const run: ProcessRunner = async (_cmd, args) => {
      capturedArgs = args;
      return okResult();
    };
    const adapter = new ClaudeCodeAdapter({ run });
    await adapter.complete("my prompt");
    expect(capturedArgs).toEqual(["-p", "--output-format", "json", "my prompt"]);
  });

  test("passes command correctly", async () => {
    let capturedCmd = "";
    const run: ProcessRunner = async (cmd) => {
      capturedCmd = cmd;
      return okResult();
    };
    const adapter = new ClaudeCodeAdapter({ run });
    await adapter.complete("test");
    expect(capturedCmd).toBe("claude");
  });

  test("CommandNotFoundError -> CLIError(not_installed)", async () => {
    const adapter = new ClaudeCodeAdapter({
      run: throwingRunner(new CommandNotFoundError("claude")),
    });
    const err = await adapter.complete("test").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CLIError);
    expect((err as CLIError).reason).toBe("not_installed");
    expect((err as CLIError).code).toBe("cli");
  });

  test("ProcessTimeoutError -> CLIError(timeout)", async () => {
    const adapter = new ClaudeCodeAdapter({
      run: throwingRunner(new ProcessTimeoutError("claude", 30000)),
    });
    const err = await adapter.complete("test").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CLIError);
    expect((err as CLIError).reason).toBe("timeout");
  });

  test("nonzero exit with auth stderr -> CLIError(not_authenticated)", async () => {
    const adapter = new ClaudeCodeAdapter({
      run: fixedRunner(okResult({ exitCode: 1, stderr: "not authenticated", stdout: "" })),
    });
    const err = await adapter.complete("test").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CLIError);
    expect((err as CLIError).reason).toBe("not_authenticated");
  });

  test("nonzero exit with 'login required' stderr -> CLIError(not_authenticated)", async () => {
    const adapter = new ClaudeCodeAdapter({
      run: fixedRunner(okResult({ exitCode: 1, stderr: "please login to continue", stdout: "" })),
    });
    const err = await adapter.complete("test").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CLIError);
    expect((err as CLIError).reason).toBe("not_authenticated");
  });

  test("nonzero exit with 'unauthorized' stderr -> CLIError(not_authenticated)", async () => {
    const adapter = new ClaudeCodeAdapter({
      run: fixedRunner(okResult({ exitCode: 1, stderr: "unauthorized access", stdout: "" })),
    });
    const err = await adapter.complete("test").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CLIError);
    expect((err as CLIError).reason).toBe("not_authenticated");
  });

  test("nonzero exit with 'api key' in stderr -> CLIError(not_authenticated)", async () => {
    const adapter = new ClaudeCodeAdapter({
      run: fixedRunner(okResult({ exitCode: 1, stderr: "not a valid api key", stdout: "" })),
    });
    const err = await adapter.complete("test").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CLIError);
    expect((err as CLIError).reason).toBe("not_authenticated");
  });

  test("nonzero exit with plain stderr -> CLIError(nonzero_exit)", async () => {
    const adapter = new ClaudeCodeAdapter({
      run: fixedRunner(okResult({ exitCode: 1, stderr: "some other error", stdout: "" })),
    });
    const err = await adapter.complete("test").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CLIError);
    expect((err as CLIError).reason).toBe("nonzero_exit");
  });

  test("nonzero exit with empty stderr -> CLIError(nonzero_exit)", async () => {
    const adapter = new ClaudeCodeAdapter({
      run: fixedRunner(okResult({ exitCode: 2, stderr: "", stdout: "" })),
    });
    const err = await adapter.complete("test").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CLIError);
    expect((err as CLIError).reason).toBe("nonzero_exit");
  });

  test("custom command override is used", async () => {
    let capturedCmd = "";
    const run: ProcessRunner = async (cmd) => {
      capturedCmd = cmd;
      return okResult();
    };
    const adapter = new ClaudeCodeAdapter({ run, command: "claude-custom" });
    await adapter.complete("test");
    expect(capturedCmd).toBe("claude-custom");
  });

  test("custom args override replaces defaults", async () => {
    let capturedArgs: readonly string[] = [];
    const run: ProcessRunner = async (_cmd, args) => {
      capturedArgs = args;
      return okResult();
    };
    const adapter = new ClaudeCodeAdapter({ run, args: ["--headless", "--json"] });
    await adapter.complete("prompt");
    expect(capturedArgs).toEqual(["--headless", "--json", "prompt"]);
  });

  test("unknown error is re-thrown as-is", async () => {
    const unexpected = new TypeError("totally unexpected");
    const adapter = new ClaudeCodeAdapter({ run: throwingRunner(unexpected) });
    const err = await adapter.complete("test").catch((e: unknown) => e);
    expect(err).toBe(unexpected);
  });

  test("nonzero exit with 429 stderr -> CLIError(rate_limited)", async () => {
    const adapter = new ClaudeCodeAdapter({
      run: fixedRunner(okResult({ exitCode: 1, stderr: "Error: 429 quota exceeded", stdout: "" })),
    });
    const err = await adapter.complete("p").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CLIError);
    expect((err as CLIError).reason).toBe("rate_limited");
  });

  test("nonzero exit with RESOURCE_EXHAUSTED stderr -> CLIError(rate_limited)", async () => {
    const adapter = new ClaudeCodeAdapter({
      run: fixedRunner(
        okResult({ exitCode: 1, stderr: "RESOURCE_EXHAUSTED: model capacity", stdout: "" }),
      ),
    });
    const err = await adapter.complete("p").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CLIError);
    expect((err as CLIError).reason).toBe("rate_limited");
  });

  test("ProcessTimeoutError carrying rate-limit stderr -> CLIError(rate_limited)", async () => {
    const t = new ProcessTimeoutError("claude", 5000, {
      stdout: "",
      stderr: "Attempt 1 failed with status 429. Retrying with backoff...",
    });
    const adapter = new ClaudeCodeAdapter({ run: throwingRunner(t) });
    const err = await adapter.complete("p").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CLIError);
    expect((err as CLIError).reason).toBe("rate_limited");
  });

  test("ProcessTimeoutError with unrelated stderr -> CLIError(timeout)", async () => {
    const t = new ProcessTimeoutError("claude", 5000, { stdout: "", stderr: "loading models..." });
    const adapter = new ClaudeCodeAdapter({ run: throwingRunner(t) });
    const err = await adapter.complete("p").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CLIError);
    expect((err as CLIError).reason).toBe("timeout");
  });
});

// ---------------------------------------------------------------------------
// ClaudeCodeAdapter — JSON envelope / usage parsing
// ---------------------------------------------------------------------------

describe("ClaudeCodeAdapter.complete — usage parsing", () => {
  /** Build a minimal valid Claude JSON envelope string. */
  function makeEnvelope(
    result: string,
    opts: {
      inputTokens?: number;
      outputTokens?: number;
      cacheRead?: number;
      cacheCreation?: number;
      model?: string;
      modelUsage?: Record<string, unknown>;
    } = {},
  ): string {
    return JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 100,
      result,
      session_id: "sess-abc",
      total_cost_usd: 0.001,
      usage: {
        input_tokens: opts.inputTokens ?? 10,
        output_tokens: opts.outputTokens ?? 5,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        cache_creation_input_tokens: opts.cacheCreation ?? 0,
      },
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.modelUsage !== undefined ? { modelUsage: opts.modelUsage } : {}),
    });
  }

  test("JSON envelope: text is the result field, usage has mapped token counts", async () => {
    const envelope = makeEnvelope("The answer is 42.", {
      inputTokens: 120,
      outputTokens: 8,
      cacheRead: 60,
      cacheCreation: 30,
      model: "claude-opus-4-5",
    });
    const adapter = new ClaudeCodeAdapter({
      run: fixedRunner(okResult({ stdout: envelope })),
    });
    const result = await adapter.complete("what is 6 times 7?");

    expect(result.text).toBe("The answer is 42.");
    expect(result.usage).toBeDefined();
    expect(result.usage?.inputTokens).toBe(120);
    expect(result.usage?.outputTokens).toBe(8);
    expect(result.usage?.cacheReadTokens).toBe(60);
    expect(result.usage?.cacheCreationTokens).toBe(30);
    expect(result.usage?.model).toBe("claude-opus-4-5");
  });

  test("JSON envelope: model resolved from modelUsage first key when top-level model absent", async () => {
    const envelope = makeEnvelope("ok", {
      inputTokens: 50,
      outputTokens: 3,
      modelUsage: { "claude-sonnet-4-6": { input_tokens: 50, output_tokens: 3 } },
    });
    const adapter = new ClaudeCodeAdapter({
      run: fixedRunner(okResult({ stdout: envelope })),
    });
    const result = await adapter.complete("ping");

    expect(result.text).toBe("ok");
    expect(result.usage?.model).toBe("claude-sonnet-4-6");
  });

  test("JSON envelope: exact contextWindow is read from the modelUsage entry", async () => {
    const envelope = makeEnvelope("ok", {
      inputTokens: 100,
      outputTokens: 4,
      modelUsage: { "claude-opus-4-8[1m]": { contextWindow: 1_000_000, maxOutputTokens: 64_000 } },
    });
    const adapter = new ClaudeCodeAdapter({
      run: fixedRunner(okResult({ stdout: envelope })),
    });
    const result = await adapter.complete("ping");

    expect(result.usage?.model).toBe("claude-opus-4-8[1m]");
    expect(result.usage?.contextWindow).toBe(1_000_000);
  });

  test("JSON envelope: contextWindow is undefined when the modelUsage entry lacks it", async () => {
    const envelope = makeEnvelope("ok", {
      inputTokens: 10,
      outputTokens: 2,
      modelUsage: { "claude-sonnet-4-6": { input_tokens: 10, output_tokens: 2 } },
    });
    const adapter = new ClaudeCodeAdapter({
      run: fixedRunner(okResult({ stdout: envelope })),
    });
    const result = await adapter.complete("ping");

    expect(result.usage?.contextWindow).toBeUndefined();
  });

  test("JSON envelope: model is null when neither model nor modelUsage is present", async () => {
    const envelope = makeEnvelope("hi", { inputTokens: 10, outputTokens: 2 });
    const adapter = new ClaudeCodeAdapter({
      run: fixedRunner(okResult({ stdout: envelope })),
    });
    const result = await adapter.complete("ping");

    expect(result.usage?.model).toBeNull();
  });

  test("plain (non-JSON) stdout: text is trimmed stdout, usage is undefined, no throw", async () => {
    const adapter = new ClaudeCodeAdapter({
      run: fixedRunner(okResult({ stdout: "  plain text response  \n" })),
    });
    const result = await adapter.complete("say something");

    expect(result.text).toBe("plain text response");
    expect(result.usage).toBeUndefined();
  });

  test("malformed JSON stdout: graceful fallback, usage undefined, no throw", async () => {
    const adapter = new ClaudeCodeAdapter({
      run: fixedRunner(okResult({ stdout: "{not valid json!!!" })),
    });
    const result = await adapter.complete("say something");

    expect(result.text).toBe("{not valid json!!!");
    expect(result.usage).toBeUndefined();
  });

  test("JSON object without result field: fallback to raw trimmed text, usage undefined", async () => {
    const adapter = new ClaudeCodeAdapter({
      run: fixedRunner(okResult({ stdout: JSON.stringify({ type: "something_else", value: 1 }) })),
    });
    const result = await adapter.complete("ping");

    // No result field — falls back to raw trimmed text.
    expect(result.usage).toBeUndefined();
    expect(typeof result.text).toBe("string");
  });

  test("JSON envelope missing usage tokens: usage is undefined", async () => {
    const noUsageEnvelope = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "hello world",
      // no usage field
    });
    const adapter = new ClaudeCodeAdapter({
      run: fixedRunner(okResult({ stdout: noUsageEnvelope })),
    });
    const result = await adapter.complete("ping");

    expect(result.text).toBe("hello world");
    expect(result.usage).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Non-Claude adapters — usage is always undefined (default parseOutput)
// ---------------------------------------------------------------------------

describe("non-Claude adapters — usage is undefined", () => {
  test("OpenCodeAdapter: complete() usage is undefined", async () => {
    const adapter = new OpenCodeAdapter({
      run: fixedRunner(okResult({ stdout: "some output\n" })),
    });
    const result = await adapter.complete("ping");
    expect(result.usage).toBeUndefined();
    expect(result.text).toBe("some output");
  });

  test("CodexAdapter: complete() usage is undefined", async () => {
    const adapter = new CodexAdapter({ run: fixedRunner(okResult({ stdout: "codex reply\n" })) });
    const result = await adapter.complete("ping");
    expect(result.usage).toBeUndefined();
    expect(result.text).toBe("codex reply");
  });

  test("GeminiCLIAdapter: complete() usage is undefined", async () => {
    const adapter = new GeminiCLIAdapter({
      run: fixedRunner(okResult({ stdout: "gemini reply\n" })),
    });
    const result = await adapter.complete("ping");
    expect(result.usage).toBeUndefined();
    expect(result.text).toBe("gemini reply");
  });
});

// ---------------------------------------------------------------------------
// probe()
// ---------------------------------------------------------------------------

describe("CLIAdapter.probe", () => {
  test("resolves when complete succeeds", async () => {
    const adapter = new ClaudeCodeAdapter({ run: fixedRunner(okResult({ stdout: "OK\n" })) });
    await expect(adapter.probe()).resolves.toBeUndefined();
  });

  test("throws CLIError(not_installed) on CommandNotFoundError", async () => {
    const adapter = new ClaudeCodeAdapter({
      run: throwingRunner(new CommandNotFoundError("claude")),
    });
    const err = await adapter.probe().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CLIError);
    expect((err as CLIError).reason).toBe("not_installed");
  });

  test("throws CLIError(timeout) on ProcessTimeoutError", async () => {
    const adapter = new ClaudeCodeAdapter({
      run: throwingRunner(new ProcessTimeoutError("claude", 30000)),
    });
    const err = await adapter.probe().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CLIError);
    expect((err as CLIError).reason).toBe("timeout");
  });

  test("throws CLIError(not_authenticated) on auth failure", async () => {
    const adapter = new ClaudeCodeAdapter({
      run: fixedRunner(okResult({ exitCode: 1, stderr: "not logged in", stdout: "" })),
    });
    const err = await adapter.probe().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CLIError);
    expect((err as CLIError).reason).toBe("not_authenticated");
  });

  test("probe(opts) passes timeoutMs through to the runner", async () => {
    let captured: number | undefined;
    const run: ProcessRunner = async (_c, _a, opts) => {
      captured = opts?.timeoutMs;
      return okResult();
    };
    const adapter = new ClaudeCodeAdapter({ run });
    await adapter.probe({ timeoutMs: 1234 });
    expect(captured).toBe(1234);
  });
});

// ---------------------------------------------------------------------------
// CLIAdapter.version()
// ---------------------------------------------------------------------------

describe("CLIAdapter.version", () => {
  test("returns the first line of <cmd> --version, trimmed", async () => {
    const adapter = new ClaudeCodeAdapter({
      run: fixedRunner(okResult({ stdout: "claude 2.1.150 (Claude Code)\n", exitCode: 0 })),
    });
    expect(await adapter.version()).toBe("claude 2.1.150 (Claude Code)");
  });

  test("multi-line stdout: only the first line", async () => {
    const adapter = new ClaudeCodeAdapter({
      run: fixedRunner(okResult({ stdout: "v1.2.3\ncommit abc\n", exitCode: 0 })),
    });
    expect(await adapter.version()).toBe("v1.2.3");
  });

  test("invokes the underlying binary with `--version`", async () => {
    let cmd = "";
    let args: readonly string[] = [];
    const run: ProcessRunner = async (c, a) => {
      cmd = c;
      args = a;
      return okResult({ stdout: "x\n", exitCode: 0 });
    };
    const adapter = new ClaudeCodeAdapter({ run });
    await adapter.version();
    expect(cmd).toBe("claude");
    expect(args).toEqual(["--version"]);
  });

  test("CommandNotFoundError -> CLIError(not_installed)", async () => {
    const adapter = new ClaudeCodeAdapter({
      run: throwingRunner(new CommandNotFoundError("claude")),
    });
    const err = await adapter.version().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CLIError);
    expect((err as CLIError).reason).toBe("not_installed");
  });

  test("nonzero exit -> CLIError(nonzero_exit)", async () => {
    const adapter = new ClaudeCodeAdapter({
      run: fixedRunner(okResult({ exitCode: 1, stdout: "", stderr: "" })),
    });
    const err = await adapter.version().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CLIError);
    expect((err as CLIError).reason).toBe("nonzero_exit");
  });

  test("ProcessTimeoutError -> CLIError(timeout)", async () => {
    const adapter = new ClaudeCodeAdapter({
      run: throwingRunner(new ProcessTimeoutError("claude", 3000)),
    });
    const err = await adapter.version().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CLIError);
    expect((err as CLIError).reason).toBe("timeout");
  });

  test("honors timeoutMs override", async () => {
    let captured: number | undefined;
    const run: ProcessRunner = async (_c, _a, opts) => {
      captured = opts?.timeoutMs;
      return okResult({ stdout: "x\n", exitCode: 0 });
    };
    const adapter = new ClaudeCodeAdapter({ run });
    await adapter.version({ timeoutMs: 999 });
    expect(captured).toBe(999);
  });
});

// ---------------------------------------------------------------------------
// All four adapters — name + default invocation shape
// ---------------------------------------------------------------------------

describe("adapter names and default invocations", () => {
  test("ClaudeCodeAdapter name='claude' args=['-p','--output-format','json']", async () => {
    let cmd = "";
    let args: readonly string[] = [];
    const run: ProcessRunner = async (c, a) => {
      cmd = c;
      args = a;
      return okResult();
    };
    const adapter = new ClaudeCodeAdapter({ run });
    expect(adapter.name).toBe("claude");
    await adapter.complete("p");
    expect(cmd).toBe("claude");
    expect(args).toEqual(["-p", "--output-format", "json", "p"]);
  });

  test("OpenCodeAdapter name='opencode' args=['run']", async () => {
    let cmd = "";
    let args: readonly string[] = [];
    const run: ProcessRunner = async (c, a) => {
      cmd = c;
      args = a;
      return okResult();
    };
    const adapter = new OpenCodeAdapter({ run });
    expect(adapter.name).toBe("opencode");
    await adapter.complete("p");
    expect(cmd).toBe("opencode");
    expect(args).toEqual(["run", "p"]);
  });

  test("CodexAdapter name='codex' args=['exec']", async () => {
    let cmd = "";
    let args: readonly string[] = [];
    const run: ProcessRunner = async (c, a) => {
      cmd = c;
      args = a;
      return okResult();
    };
    const adapter = new CodexAdapter({ run });
    expect(adapter.name).toBe("codex");
    await adapter.complete("p");
    expect(cmd).toBe("codex");
    expect(args).toEqual(["exec", "p"]);
  });

  test("GeminiCLIAdapter name='gemini' args=['-p']", async () => {
    let cmd = "";
    let args: readonly string[] = [];
    const run: ProcessRunner = async (c, a) => {
      cmd = c;
      args = a;
      return okResult();
    };
    const adapter = new GeminiCLIAdapter({ run });
    expect(adapter.name).toBe("gemini");
    await adapter.complete("p");
    expect(cmd).toBe("gemini");
    expect(args).toEqual(["-p", "p"]);
  });
});

// ---------------------------------------------------------------------------
// detectAvailableCLIs
// ---------------------------------------------------------------------------

describe("detectAvailableCLIs", () => {
  test("returns names of CLIs where which exits 0", async () => {
    const run: ProcessRunner = async (_cmd, args) => {
      const name = args[0];
      if (name === "claude" || name === "codex") {
        return okResult({ stdout: `/usr/local/bin/${name}\n` });
      }
      return okResult({ exitCode: 1, stdout: "" });
    };
    const result = await detectAvailableCLIs(run);
    expect(result).toEqual(["claude", "codex"]);
  });

  test("returns empty array when all which calls fail", async () => {
    const result = await detectAvailableCLIs(async () => okResult({ exitCode: 1, stdout: "" }));
    expect(result).toEqual([]);
  });

  test("returns all names when all which calls succeed", async () => {
    const result = await detectAvailableCLIs(async (_cmd, args) =>
      okResult({ stdout: `/usr/bin/${args[0] ?? ""}\n` }),
    );
    expect(result).toEqual(["claude", "opencode", "codex", "gemini"]);
  });

  test("handles CommandNotFoundError on which itself gracefully", async () => {
    const result = await detectAvailableCLIs(throwingRunner(new CommandNotFoundError("which")));
    expect(result).toEqual([]);
  });

  test("handles unexpected runner errors gracefully", async () => {
    const result = await detectAvailableCLIs(throwingRunner(new Error("random spawn error")));
    expect(result).toEqual([]);
  });

  test("only probes the 'which' command (not the adapters directly)", async () => {
    const probed: string[] = [];
    const run: ProcessRunner = async (cmd, args) => {
      probed.push(`${cmd} ${args.join(" ")}`);
      return okResult({ exitCode: 1, stdout: "" });
    };
    await detectAvailableCLIs(run);
    expect(probed.every((s) => s.startsWith("which "))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// selectDefault
// ---------------------------------------------------------------------------

describe("selectDefault", () => {
  test("returns configuredDefault when installed", () => {
    expect(selectDefault(["claude", "opencode"], "opencode")).toBe("opencode");
  });

  test("ignores configuredDefault when not installed, falls back to priority", () => {
    expect(selectDefault(["opencode", "codex"], "gemini")).toBe("opencode");
  });

  test("priority order: claude > opencode > codex > gemini", () => {
    expect(selectDefault(["gemini", "codex", "opencode", "claude"])).toBe("claude");
    expect(selectDefault(["gemini", "codex", "opencode"])).toBe("opencode");
    expect(selectDefault(["gemini", "codex"])).toBe("codex");
    expect(selectDefault(["gemini"])).toBe("gemini");
  });

  test("returns undefined when nothing is installed", () => {
    expect(selectDefault([])).toBeUndefined();
    expect(selectDefault([], "opencode")).toBeUndefined();
  });

  test("returns configuredDefault that is also first in priority", () => {
    expect(selectDefault(["claude", "opencode"], "claude")).toBe("claude");
  });
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe("ADAPTER_REGISTRY / buildAdapter", () => {
  test("registry contains all four adapters", () => {
    expect(Object.keys(ADAPTER_REGISTRY).sort()).toEqual(["claude", "codex", "gemini", "opencode"]);
  });

  test("buildAdapter returns correct adapter instance", () => {
    const claude = buildAdapter("claude");
    expect(claude?.name).toBe("claude");

    const opencode = buildAdapter("opencode");
    expect(opencode?.name).toBe("opencode");

    const codex = buildAdapter("codex");
    expect(codex?.name).toBe("codex");

    const gemini = buildAdapter("gemini");
    expect(gemini?.name).toBe("gemini");
  });

  test("buildAdapter returns undefined for unknown name", () => {
    expect(buildAdapter("unknown-cli")).toBeUndefined();
  });

  test("buildAdapter passes options to the adapter", async () => {
    let capturedCmd = "";
    const run: ProcessRunner = async (cmd) => {
      capturedCmd = cmd;
      return okResult();
    };
    const adapter = buildAdapter("claude", { run, command: "claude-override" });
    await adapter?.complete("hello");
    expect(capturedCmd).toBe("claude-override");
  });
});
