/**
 * Render a {@link QrMatrix} to a scannable terminal string using Unicode half-block
 * glyphs and ANSI colors. Two module rows are packed into one text row (top half /
 * bottom half of each cell), so the output is roughly half as tall as the matrix.
 *
 * Contrast direction (CRITICAL for scannability): a QR code is DARK modules on a LIGHT
 * field, and most scanners assume that polarity. We therefore set a WHITE background
 * with BLACK foreground, and draw the DARK modules as the (black) block glyphs while
 * LIGHT modules / the quiet zone stay as the white background. A 1-module quiet zone
 * is added on every side so finder patterns are not clipped.
 *
 * Ported from OpenClaw's proven terminal QR renderer; adapted to {@link QrMatrix}.
 */

import { type QrMatrix, readModule } from "./qr.ts";

/** Quiet-zone width in modules added on every side. */
const QUIET = 1;

/** ANSI: white background + black foreground, so block glyphs render dark-on-light. */
const WHITE_ON_BLACK_INVERSE = "\x1b[47m\x1b[30m";

/** ANSI reset. */
const RESET = "\x1b[0m";

/** Both halves dark. */
const FULL = "█"; // full block
/** Top half dark only. */
const UPPER = "▀"; // upper half block
/** Bottom half dark only. */
const LOWER = "▄"; // lower half block
/** Neither half dark. */
const EMPTY = " ";

/**
 * Render `matrix` to a multi-line, ANSI-colored, half-block QR string.
 *
 * Each output line is wrapped with the white-on-black inverse SGR prefix and a RESET
 * suffix; lines are joined with `\n`. The result is ready to `print`/`write` to a TTY.
 *
 * @param matrix - The QR matrix to render (`true` = dark module).
 * @returns The joined terminal string (no trailing newline).
 */
export function renderQrTerminal(matrix: QrMatrix): string {
  const size = matrix.size;
  const lo = -QUIET;
  const hi = size + QUIET;

  const lines: string[] = [];
  // Step two module-rows at a time: top = row y, bottom = row y+1.
  for (let y = lo; y < hi; y += 2) {
    let line = "";
    for (let x = lo; x < hi; x++) {
      const top = readModule(matrix, x, y);
      const bottom = readModule(matrix, x, y + 1);
      if (top && bottom) {
        line += FULL;
      } else if (top) {
        line += UPPER;
      } else if (bottom) {
        line += LOWER;
      } else {
        line += EMPTY;
      }
    }
    lines.push(`${WHITE_ON_BLACK_INVERSE}${line}${RESET}`);
  }

  return lines.join("\n");
}
