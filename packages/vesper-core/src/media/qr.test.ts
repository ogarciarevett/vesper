import { describe, expect, test } from "bun:test";
import { encodeQr, type QrMatrix, readModule } from "./qr.ts";

/** Serialize a matrix to an array of row strings (`#` = dark, space = light). */
function toRows(m: QrMatrix): string[] {
  const rows: string[] = [];
  for (let y = 0; y < m.size; y++) {
    let r = "";
    for (let x = 0; x < m.size; x++) {
      r += readModule(m, x, y) ? "#" : " ";
    }
    rows.push(r);
  }
  return rows;
}

/** Version implied by a matrix size (`size = 4 * version + 17`). */
function versionOf(size: number): number {
  return (size - 17) / 4;
}

/** Assert the 7x7 finder ring at origin `(ox, oy)` matches the QR finder pattern. */
function expectFinderRing(m: QrMatrix, ox: number, oy: number): void {
  const expected = ["#######", "#     #", "# ### #", "# ### #", "# ### #", "#     #", "#######"];
  for (let y = 0; y < expected.length; y++) {
    const row = expected[y] ?? "";
    for (let x = 0; x < 7; x++) {
      const dark = readModule(m, ox + x, oy + y);
      expect(dark).toBe(row.charAt(x) === "#");
    }
  }
}

describe("encodeQr", () => {
  test("is deterministic for a given (text, ecc)", () => {
    const a = encodeQr("https://t.me/vesperbot?start=PAIRTEST", { ecc: "M" });
    const b = encodeQr("https://t.me/vesperbot?start=PAIRTEST", { ecc: "M" });
    expect(a.size).toBe(b.size);
    expect(a.modules).toEqual(b.modules);
  });

  test("ecc defaults to M (same matrix as explicit M)", () => {
    const implicit = encodeQr("vesper");
    const explicit = encodeQr("vesper", { ecc: "M" });
    expect(implicit.modules).toEqual(explicit.modules);
  });

  test("size has the form 4*version + 17", () => {
    for (const text of ["hi", "https://t.me/vesperbot?start=PAIRTEST", "A".repeat(200)]) {
      const m = encodeQr(text);
      expect((m.size - 17) % 4).toBe(0);
      const version = versionOf(m.size);
      expect(version).toBeGreaterThanOrEqual(1);
      expect(version).toBeLessThanOrEqual(40);
      expect(m.modules.length).toBe(m.size * m.size);
    }
  });

  test("known sizes: short fits version 1, size grows with length", () => {
    const short = encodeQr("hi", { ecc: "M" });
    expect(short.size).toBe(21); // version 1
    expect(versionOf(short.size)).toBe(1);

    const golden = encodeQr("https://t.me/vesperbot?start=PAIRTEST", { ecc: "M" });
    expect(golden.size).toBe(29); // version 3

    const long = encodeQr(`https://t.me/vesperbot?start=${"A".repeat(120)}`, { ecc: "M" });
    expect(long.size).toBe(49); // version 9

    expect(short.size).toBeLessThan(golden.size);
    expect(golden.size).toBeLessThan(long.size);
  });

  test("the three finder patterns exist at the three corners", () => {
    const m = encodeQr("https://t.me/vesperbot?start=PAIRTEST", { ecc: "M" });
    expectFinderRing(m, 0, 0); // top-left
    expectFinderRing(m, m.size - 7, 0); // top-right
    expectFinderRing(m, 0, m.size - 7); // bottom-left
    // The bottom-right corner has NO finder pattern in a QR code.
    expect(readModule(m, m.size - 1, m.size - 1)).toBe(false);
  });

  test("timing patterns on row 6 and column 6 alternate", () => {
    const m = encodeQr("https://t.me/vesperbot?start=PAIRTEST", { ecc: "M" });
    // Between the finder patterns (x and y in [8, size-9]) the timing line alternates,
    // dark on even coordinates.
    for (let i = 8; i <= m.size - 9; i++) {
      expect(readModule(m, i, 6)).toBe(i % 2 === 0); // horizontal timing (row 6)
      expect(readModule(m, 6, i)).toBe(i % 2 === 0); // vertical timing (col 6)
    }
  });

  test("throws a clear error when the text is too long for version 40", () => {
    // Version 40 at ECC H holds far fewer than 8000 bytes; this overflows every version.
    const tooLong = "A".repeat(8000);
    expect(() => encodeQr(tooLong, { ecc: "H" })).toThrow(/too long/i);
  });

  test("higher ecc never produces a smaller matrix for the same text", () => {
    const text = "https://t.me/vesperbot?start=PAIRTEST";
    const l = encodeQr(text, { ecc: "L" });
    const h = encodeQr(text, { ecc: "H" });
    expect(h.size).toBeGreaterThanOrEqual(l.size);
  });

  test("readModule returns false out of bounds", () => {
    const m = encodeQr("hi");
    expect(readModule(m, -1, 0)).toBe(false);
    expect(readModule(m, 0, -1)).toBe(false);
    expect(readModule(m, m.size, 0)).toBe(false);
    expect(readModule(m, 0, m.size)).toBe(false);
  });

  test("golden snapshot for a Vesper pairing URL (regression guard)", () => {
    // Frozen from this faithful Nayuki port; cross-checked byte-for-byte against the
    // upstream qrcodegen reference. A change here means the encoder regressed.
    const GOLDEN: readonly string[] = [
      "#######    ## #### #  #######",
      "#     #   # # ####    #     #",
      "# ### # #  ##       # # ### #",
      "# ### # # ##   ###  # # ### #",
      "# ### # # #### ##  ## # ### #",
      "#     # #  ######## # #     #",
      "####### # # # # # # # #######",
      "        ### ## ##  ##        ",
      "# #####  #  # ## # #  #####  ",
      "  ###  ######  ##  #### #   #",
      "  ## ##   ###  #      ###    ",
      "# #### #   #  ### ##  #### # ",
      " ###  ###   #  ###       ##  ",
      "#      #   ###### ### ###   #",
      " #  ###### #####  #    ####  ",
      "#####   ######     # ###   # ",
      "      # ##  # ####  #    ##  ",
      "# # ##  # #    ##  ###### # #",
      "#   # #   ##   #### #     #  ",
      "# ##   # ###  ##  # #  #   # ",
      "#   ####### #    #  ##### ###",
      "        ## ######   #   #####",
      "#######  # ######  ## # ###  ",
      "#     # # #  # #  ###   #    ",
      "# ### # ### # ## ## ##### #  ",
      "# ### # ##   # ###       ####",
      "# ### # ##### ##      # #### ",
      "#     #     ####   ###  ## # ",
      "####### ### # ###  #  #####  ",
    ];
    const m = encodeQr("https://t.me/vesperbot?start=PAIRTEST", { ecc: "M" });
    expect(toRows(m)).toEqual([...GOLDEN]);
  });
});
