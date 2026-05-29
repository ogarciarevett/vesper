import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  bold,
  colorEnabled,
  formatKeyValues,
  padVisible,
  statusToken,
  table,
  visibleLength,
} from "./ui.ts";

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

  test("visibleLength ignores ANSI escape codes", () => {
    // In NO_COLOR mode `bold` is plain, so wrap a raw escape to exercise stripping.
    const colored = `\x1b[1mhi\x1b[0m`;
    expect(visibleLength(colored)).toBe(2);
    expect(visibleLength("plain")).toBe(5);
  });

  test("padVisible pads by visible width (ignoring ANSI)", () => {
    expect(padVisible("ab", 5)).toBe("ab   ");
    expect(padVisible(`\x1b[1mab\x1b[0m`, 5)).toBe(`\x1b[1mab\x1b[0m   `);
    expect(padVisible("toolong", 3)).toBe("toolong");
  });

  test("table aligns columns to the widest cell and renders a rule", () => {
    const out = table(
      ["id", "kind"],
      [
        ["echo", "manual"],
        ["x", "cron"],
      ],
    );
    const lines = out.split("\n");
    expect(lines).toHaveLength(4); // header + rule + 2 rows
    // header padded to width of "manual" / "echo"
    expect(lines[0]).toBe("  id    kind  ");
    expect(lines[2]).toBe("  echo  manual");
    expect(lines[3]).toBe("  x     cron  ");
  });

  test("table handles zero rows (header + rule only)", () => {
    const out = table(["a", "b"], []);
    expect(out.split("\n")).toHaveLength(2);
  });
});

describe("colorEnabled precedence (NO_COLOR / FORCE_COLOR)", () => {
  let priorNo: string | undefined;
  let priorForce: string | undefined;

  beforeAll(() => {
    priorNo = process.env.NO_COLOR;
    priorForce = process.env.FORCE_COLOR;
  });
  const restore = (key: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  afterAll(() => {
    restore("NO_COLOR", priorNo);
    restore("FORCE_COLOR", priorForce);
  });

  test("FORCE_COLOR enables color even without a TTY", () => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";
    expect(colorEnabled()).toBe(true);
  });

  test("NO_COLOR overrides FORCE_COLOR", () => {
    process.env.NO_COLOR = "1";
    process.env.FORCE_COLOR = "1";
    expect(colorEnabled()).toBe(false);
  });

  test("FORCE_COLOR=0 does not force color", () => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "0";
    // Not a TTY under `bun test` piped → false.
    expect(colorEnabled()).toBe(false);
  });
});
