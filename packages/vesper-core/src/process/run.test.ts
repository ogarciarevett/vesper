import { describe, expect, test } from "bun:test";
import { CommandNotFoundError, ProcessTimeoutError, runProcess } from "./run.ts";

describe("runProcess", () => {
  test("captures stdout and a zero exit code", async () => {
    const res = await runProcess("printf", ["%s", "hello"]);
    expect(res.stdout).toBe("hello");
    expect(res.exitCode).toBe(0);
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("reports a non-zero exit code without throwing", async () => {
    const res = await runProcess("false", []);
    expect(res.exitCode).not.toBe(0);
  });

  test("writes the provided input to stdin", async () => {
    const res = await runProcess("cat", [], { input: "piped-in" });
    expect(res.stdout).toBe("piped-in");
  });

  test("throws CommandNotFoundError for a missing binary", async () => {
    await expect(runProcess("vesper-definitely-not-a-real-binary", [])).rejects.toBeInstanceOf(
      CommandNotFoundError,
    );
  });

  test("throws ProcessTimeoutError when a command outlives its timeout", async () => {
    await expect(runProcess("sleep", ["5"], { timeoutMs: 20 })).rejects.toBeInstanceOf(
      ProcessTimeoutError,
    );
  });

  test("ProcessTimeoutError carries partial stdout/stderr captured before kill", async () => {
    // Single Bun process (no child) so kill closes the pipes immediately.
    const inline =
      "console.log('out'); console.error('err'); await new Promise((r) => setTimeout(r, 5000));";
    let caught: ProcessTimeoutError | undefined;
    try {
      await runProcess("bun", ["-e", inline], { timeoutMs: 400 });
    } catch (e) {
      if (e instanceof ProcessTimeoutError) caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught?.stdout).toContain("out");
    expect(caught?.stderr).toContain("err");
  });
});
