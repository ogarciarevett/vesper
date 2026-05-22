import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { bold, colorEnabled, formatKeyValues, statusToken } from "./ui.ts";

// Color depends on NO_COLOR + stdout.isTTY, so `bun test` is plain when piped (CI)
// but colored under an interactive TTY. Force NO_COLOR here to assert the plain-mode
// branch deterministically, regardless of how the suite is launched.
describe("ui (plain mode, NO_COLOR forced)", () => {
  let priorNoColor: string | undefined;

  beforeAll(() => {
    priorNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
  });

  afterAll(() => {
    if (priorNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = priorNoColor;
    }
  });

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
