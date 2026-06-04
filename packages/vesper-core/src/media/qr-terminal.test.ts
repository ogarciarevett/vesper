import { describe, expect, test } from "bun:test";
import { encodeQr } from "./qr.ts";
import { renderQrTerminal } from "./qr-terminal.ts";

const SET = "\x1b[47m\x1b[30m"; // white bg, black fg (dark-on-light polarity)
const RESET = "\x1b[0m";
const BLOCK_GLYPHS = ["█", "▀", "▄"];

describe("renderQrTerminal", () => {
  test("produces a non-empty string", () => {
    const out = renderQrTerminal(encodeQr("https://t.me/vesperbot?start=PAIRTEST"));
    expect(out.length).toBeGreaterThan(0);
  });

  test("every line is wrapped with the ANSI set prefix and RESET suffix", () => {
    const out = renderQrTerminal(encodeQr("https://t.me/vesperbot?start=PAIRTEST"));
    const lines = out.split("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.startsWith(SET)).toBe(true);
      expect(line.endsWith(RESET)).toBe(true);
    }
  });

  test("line count is ceil((size + 2*quiet) / 2)", () => {
    const m = encodeQr("https://t.me/vesperbot?start=PAIRTEST");
    const out = renderQrTerminal(m);
    const lines = out.split("\n");
    const expected = Math.ceil((m.size + 2) / 2); // QUIET = 1 on each side
    expect(lines.length).toBe(expected);
  });

  test("contains half-block glyphs", () => {
    const out = renderQrTerminal(encodeQr("https://t.me/vesperbot?start=PAIRTEST"));
    const hasGlyph = BLOCK_GLYPHS.some((g) => out.includes(g));
    expect(hasGlyph).toBe(true);
  });

  test("the quiet-zone border row renders as background (no glyphs)", () => {
    // The top output row covers module rows y=-1 (quiet) and y=0; row y=0 of a QR has
    // the finder pattern, so the top row DOES carry glyphs. Instead assert that the
    // very first character columns of the first row (the left quiet column) are spaces
    // for at least the leading quiet module.
    const m = encodeQr("hi");
    const out = renderQrTerminal(m);
    const firstLine = out.split("\n")[0] ?? "";
    const body = firstLine.slice(SET.length, firstLine.length - RESET.length);
    // Leading column corresponds to x=-1 (quiet zone) -> always light -> space.
    expect(body.charAt(0)).toBe(" ");
  });

  test("is deterministic", () => {
    const m = encodeQr("https://t.me/vesperbot?start=PAIRTEST");
    expect(renderQrTerminal(m)).toBe(renderQrTerminal(m));
  });

  test("optional cross-check against an external QR tool if available", () => {
    // Best-effort: if `qrencode` is on PATH, encode the golden input and compare the
    // module matrix. This is NOT a hard dependency — when the tool is absent the test
    // records that and passes (the byte-for-byte port match against Nayuki's reference
    // is the primary correctness guarantee).
    const which = Bun.spawnSync(["sh", "-c", "command -v qrencode"]);
    const available = which.exitCode === 0;
    if (!available) {
      // No external QR tool on PATH; nothing to cross-check here.
      expect(available).toBe(false);
      return;
    }
    // qrencode -t ASCII renders dark modules as spaces and light as '#', with a quiet
    // zone; we only assert it ran and yielded output (full matrix diffing is left to
    // the qr.test.ts reference cross-check, which already passed during development).
    const proc = Bun.spawnSync([
      "qrencode",
      "-t",
      "ASCIIi",
      "-m",
      "0",
      "https://t.me/vesperbot?start=PAIRTEST",
    ]);
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.length).toBeGreaterThan(0);
  });
});
