/**
 * Per-machine "agent face": a deterministic robot avatar composed from curated
 * glyph pools, seeded by a hash of a stable machine fingerprint. Every machine
 * gets its own recognizable Vesper agent. Parts are composed at fixed widths so
 * every one of the millions of combinations renders cleanly.
 *
 * Privacy: the fingerprint mixes in the first hardware MAC as entropy, but it is
 * SHA-256 hashed before use and never displayed, logged, or stored. Only a short
 * 6-hex id derived from the hash is shown.
 */

import { createHash } from "node:crypto";
import { hostname, networkInterfaces, platform } from "node:os";

/** A frame style: [top, bottom, leftSide, rightSide]. Inner width is 9. */
type Frame = readonly [string, string, string, string];

/** Center `s` in a field `width` columns wide (counted by code points). */
function center(s: string, width: number): string {
  const n = [...s].length;
  const pad = Math.max(0, width - n);
  const left = Math.floor(pad / 2);
  return " ".repeat(left) + s + " ".repeat(pad - left);
}

/** Assert a non-empty array literal as a non-empty tuple (builders never empty). */
function nonEmpty<T>(arr: readonly T[]): readonly [T, ...T[]] {
  return arr as readonly [T, ...T[]];
}

// --- eyes: symmetric glyph + odd gap, centered to width 9 -------------------
const EYE_GLYPHS = [..."◉●◕⊙o◔⊚◍◎○◯⊛⊕⊗◦▢°•◇◆□■▰▮▪✦◐◑⊝⊜⊖⊘⦿◈x"];
const EYE_GAPS = [1, 3, 5];
const EYES = nonEmpty(
  EYE_GLYPHS.flatMap((g) => EYE_GAPS.map((gap) => center(`${g}${" ".repeat(gap)}${g}`, 9))),
);

// --- mouths: tileable bases x widths + standalone shapes, centered to 9 -----
const MOUTH_TILES = [..."─═━╌┄┈▔▁╍╴~=•"];
const MOUTH_SHAPES = [
  "▽",
  "∇",
  "◡",
  "‿",
  "⌣",
  "◠",
  "○",
  "◇",
  "◊",
  "⌐¬",
  "╰╯",
  "╭╮",
  "◞◟",
  "◜◝",
  "v v",
  "< >",
  "[_]",
  "︶",
  "⩊",
  "≖",
  "ᴗ",
  "└┴┘",
  "┌┬┐",
  "╧╧╧",
  "┴┴┴",
  "▭▭▭",
  "⊏⊐",
  "≈",
  "•‿•",
];
const MOUTHS = nonEmpty([
  ...MOUTH_TILES.flatMap((t) => [1, 3, 5].map((w) => center(t.repeat(w), 9))),
  ...MOUTH_SHAPES.map((m) => center(m, 9)),
]);

// --- antennae: tip glyph x mount form, centered to width 11 -----------------
const ANT_TIPS = [..."¤◉●◆◇□■▲▼▿▵◈✦✧∆╤⊕⊙◎"];
const ANT_FORMS: ReadonlyArray<(t: string) => string> = [
  (t) => t,
  (t) => `(${t})`,
  (t) => `\\${t}/`,
  (t) => `─${t}─`,
  (t) => `o${t}o`,
  (t) => `[${t}]`,
  (t) => `╴${t}╶`,
];
const ANTENNAE = nonEmpty([
  ...ANT_TIPS.flatMap((t) => ANT_FORMS.map((f) => center(f(t), 11))),
  " ".repeat(11), // bald
]);

// --- frames: curated box-drawing/ASCII sets ---------------------------------
function frame(corners: string, edge: string, side: string): Frame {
  const [tl, tr, bl, br] = [...corners];
  return [`${tl}${edge.repeat(9)}${tr}`, `${bl}${edge.repeat(9)}${br}`, side, side];
}
const FRAMES: readonly [Frame, ...Frame[]] = [
  frame("┌┐└┘", "─", "│"),
  frame("╭╮╰╯", "─", "│"),
  frame("╔╗╚╝", "═", "║"),
  frame("┏┓┗┛", "━", "┃"),
  frame("┌┐└┘", "┄", "┊"),
  frame("┌┐└┘", "┈", "┆"),
  frame("┌┐└┘", "╌", "╎"),
  frame("┏┓┗┛", "┅", "┇"),
  frame("┏┓┗┛", "┉", "┋"),
  frame("╭╮╰╯", "┄", "┊"),
  frame("╭╮╰╯", "┈", "┆"),
  [`▛${"▀".repeat(9)}▜`, `▙${"▄".repeat(9)}▟`, "▌", "▐"],
  frame("++++", "-", "|"),
];

/** Variant tables exposed for tests (width-invariance checks). */
export const VARIANTS = { EYES, MOUTHS, ANTENNAE, FRAMES } as const;

/** Deterministically pick from a non-empty table; never returns undefined. */
function pick<T>(table: readonly [T, ...T[]], byte: number | undefined): T {
  const i = (byte ?? 0) % table.length;
  return i === 0 ? table[0] : (table[i] ?? table[0]);
}

/**
 * A stable-ish per-machine fingerprint. The first non-internal MAC is mixed in
 * as entropy; callers hash it (see {@link faceFromSeed}) and never surface it raw.
 */
export function machineFingerprint(): string {
  const macs = Object.values(networkInterfaces())
    .flat()
    .filter(
      (n): n is NonNullable<typeof n> => n != null && !n.internal && n.mac !== "00:00:00:00:00:00",
    )
    .map((n) => n.mac)
    .sort();
  return `${hostname()}|${platform()}|${macs[0] ?? ""}`;
}

/** A deterministic agent face (5 lines, 11 cols each) + short id from a seed. */
export function faceFromSeed(seed: string): { lines: string[]; id: string } {
  const h = createHash("sha256").update(seed).digest();
  const [top, bottom, left, right] = pick(FRAMES, h[3]);
  const lines = [
    pick(ANTENNAE, h[0]),
    top,
    `${left}${pick(EYES, h[1])}${right}`,
    `${left}${pick(MOUTHS, h[2])}${right}`,
    bottom,
  ];
  return { lines, id: h.toString("hex").slice(0, 6) };
}

/** This machine's unique agent face + id. */
export function agentFace(): { lines: string[]; id: string } {
  return faceFromSeed(machineFingerprint());
}
