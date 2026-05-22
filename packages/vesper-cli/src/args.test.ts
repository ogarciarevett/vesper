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
});
