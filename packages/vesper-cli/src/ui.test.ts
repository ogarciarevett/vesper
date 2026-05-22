import { describe, expect, test } from "bun:test";
import { bold, colorEnabled, formatKeyValues, statusToken } from "./ui.ts";

// `bun test` runs with stdout that is not a TTY, so color is disabled — output is plain.
describe("ui (plain mode under non-TTY test output)", () => {
  test("colorEnabled is false", () => {
    expect(colorEnabled()).toBe(false);
  });

  test("style functions return plain text when color is disabled", () => {
    expect(bold("hi")).toBe("hi");
    expect(statusToken("ok", "ok")).toBe("ok");
    expect(statusToken("bad", "not-installed")).toBe("not-installed");
  });

  test("formatKeyValues pads keys to the widest key", () => {
    const out = formatKeyValues([
      ["short", "x"],
      ["longerkey", "y"],
    ]);
    const [first, second] = out.split("\n");
    expect(first).toBe(`  ${"short".padEnd("longerkey".length)}  x`);
    expect(second).toBe("  longerkey  y");
  });
});
