import { describe, expect, test } from "bun:test";
import { parseArgs } from "./args.ts";

describe("parseArgs", () => {
  test("collects positionals in order", () => {
    expect(parseArgs(["vault", "set", "gh-token"]).positionals).toEqual([
      "vault",
      "set",
      "gh-token",
    ]);
  });

  test("parses boolean and valued flags", () => {
    const { flags } = parseArgs(["--help", "--name=claude"]);
    expect(flags.help).toBe(true);
    expect(flags.name).toBe("claude");
  });

  test("separates flags from positionals regardless of position", () => {
    const result = parseArgs(["status", "--verbose", "extra"]);
    expect(result.positionals).toEqual(["status", "extra"]);
    expect(result.flags.verbose).toBe(true);
  });

  test("value-flags consume the next token", () => {
    const valueFlags = new Set(["cli", "param"]);
    const result = parseArgs(
      ["run", "echo", "--cli", "claude", "--param", "prompt=hi"],
      valueFlags,
    );
    expect(result.positionals).toEqual(["run", "echo"]);
    expect(result.flags.cli).toBe("claude");
    expect(result.flags.param).toBe("prompt=hi");
  });

  test("value-flag with =value still works", () => {
    const result = parseArgs(["run", "--cli=codex"], new Set(["cli"]));
    expect(result.flags.cli).toBe("codex");
  });

  test("value-flag at end of argv (no following token) is a boolean", () => {
    const result = parseArgs(["run", "echo", "--cli"], new Set(["cli"]));
    expect(result.flags.cli).toBe(true);
    expect(result.positionals).toEqual(["run", "echo"]);
  });

  test("value-flag does not consume a following flag", () => {
    const result = parseArgs(["--cli", "--verbose"], new Set(["cli"]));
    expect(result.flags.cli).toBe(true);
    expect(result.flags.verbose).toBe(true);
  });

  test("non-value flags stay positional-order-independent", () => {
    // `param` is not in the value-flag set here, so it stays boolean and the
    // following token remains a positional.
    const result = parseArgs(["run", "--param", "prompt=hi"], new Set(["cli"]));
    expect(result.flags.param).toBe(true);
    expect(result.positionals).toEqual(["run", "prompt=hi"]);
  });
});
