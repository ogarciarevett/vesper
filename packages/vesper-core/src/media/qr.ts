/**
 * Dependency-free QR Code encoder — a faithful TypeScript port of Project Nayuki's
 * public-domain "QR Code generator" library (MIT). It covers the QR Code Model 2
 * specification: byte / alphanumeric / numeric segment modes, Reed-Solomon error
 * correction over GF(2^8 / 0x11D), automatic version auto-fit, and the standard
 * 8-mask penalty selection. Encoding is fully DETERMINISTIC for a given (text, ecc):
 * the mask is chosen by the standard penalty rule, never by randomness, `Date`, or
 * `Math.random` — so the same input always yields the same matrix.
 *
 * The public surface is small ({@link encodeQr} -> {@link QrMatrix}); the porting of
 * the algorithm lives in module-private helpers below. Inner grids and buffers use
 * typed arrays so element access is total (no `undefined`) and assertion-free.
 *
 * Reference: https://www.nayuki.io/page/qr-code-generator-library (Project Nayuki, MIT).
 */

/** Error correction level: `L` ~7%, `M` ~15%, `Q` ~25%, `H` ~30% recoverable. */
export type QrEcc = "L" | "M" | "Q" | "H";

/**
 * An immutable square grid of QR modules.
 *
 * `modules` is row-major: the module at `(x, y)` is `modules[y * size + x]`, where
 * `true` = dark (foreground) and `false` = light (background).
 */
export interface QrMatrix {
  /** Side length in modules; always `4 * version + 17` (21..177). */
  readonly size: number;
  /** Row-major dark/light flags; `modules[y * size + x]`. */
  readonly modules: readonly boolean[];
}

/** Options for {@link encodeQr}. */
export interface EncodeQrOptions {
  /** Error correction level; defaults to `"M"`. */
  readonly ecc?: QrEcc;
}

const MIN_VERSION = 1;
const MAX_VERSION = 40;

// Penalty constants used by the automatic mask-selection rule.
const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

/** Ordinal + format-bit pair for each ECC level (Nayuki's `Ecc` enum, ported). */
interface EccSpec {
  readonly ordinal: number;
  readonly formatBits: number;
}

const ECC_SPECS: Readonly<Record<QrEcc, EccSpec>> = {
  L: { ordinal: 0, formatBits: 1 },
  M: { ordinal: 1, formatBits: 0 },
  Q: { ordinal: 2, formatBits: 3 },
  H: { ordinal: 3, formatBits: 2 },
};

/** ECC levels ordered low -> high for the boost pass (excludes `L`, the floor). */
const ECC_BOOST_ORDER: readonly QrEcc[] = ["M", "Q", "H"];

// Number of error-correction codewords per block, indexed [eccOrdinal][version].
// Index 0 of each row is padding (illegal). Stored as typed arrays so lookups are total.
const ECC_CODEWORDS_PER_BLOCK: readonly Int16Array[] = [
  Int16Array.from([
    -1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30,
    30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ]),
  Int16Array.from([
    -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28,
    28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
  ]),
  Int16Array.from([
    -1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30,
    30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ]),
  Int16Array.from([
    -1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30,
    30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ]),
];

// Number of error-correction blocks, indexed [eccOrdinal][version]. Same layout.
const NUM_ERROR_CORRECTION_BLOCKS: readonly Int16Array[] = [
  Int16Array.from([
    -1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14,
    15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25,
  ]),
  Int16Array.from([
    -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23,
    25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
  ]),
  Int16Array.from([
    -1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34,
    34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68,
  ]),
  Int16Array.from([
    -1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35,
    37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81,
  ]),
];

/** Look up an ECC-table cell by [ecc][version] from one of the typed-array tables. */
function eccTableCell(table: readonly Int16Array[], ordinal: number, version: number): number {
  const row = table[ordinal];
  if (row === undefined) {
    throw new Error(`qr: invalid ecc ordinal ${ordinal}`);
  }
  return row[version] as number;
}

const ALPHANUMERIC_CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
const NUMERIC_REGEX = /^[0-9]*$/;
const ALPHANUMERIC_REGEX = /^[A-Z0-9 $%*+./:-]*$/;

/** Mode indicator + per-version-range character-count widths. */
interface SegmentMode {
  readonly modeBits: number;
  readonly charCountBits: readonly [number, number, number];
}

const MODE_NUMERIC: SegmentMode = { modeBits: 0x1, charCountBits: [10, 12, 14] };
const MODE_ALPHANUMERIC: SegmentMode = { modeBits: 0x2, charCountBits: [9, 11, 13] };
const MODE_BYTE: SegmentMode = { modeBits: 0x4, charCountBits: [8, 16, 16] };

/** A character/binary data segment: a mode, a character count, and the data bits. */
interface QrSegment {
  readonly mode: SegmentMode;
  readonly numChars: number;
  readonly bits: readonly number[];
}

/** Character-count field width for `mode` at `version` (Nayuki's `numCharCountBits`). */
function charCountBits(mode: SegmentMode, version: number): number {
  const [a, b, c] = mode.charCountBits;
  const range = Math.floor((version + 7) / 17);
  return range === 0 ? a : range === 1 ? b : c;
}

/**
 * Append the low `len` bits of `value` (most-significant first) to `acc`.
 * Mirrors Nayuki's `appendBits`; throws if the value does not fit `len` bits.
 */
function appendBits(value: number, len: number, acc: number[]): void {
  if (len < 0 || len > 31 || value >>> len !== 0) {
    throw new Error(`qr: bit value out of range (value=${value}, len=${len})`);
  }
  for (let i = len - 1; i >= 0; i--) {
    acc.push((value >>> i) & 1);
  }
}

/** Returns true iff the `i`-th bit of `x` is set. */
function getBit(x: number, i: number): boolean {
  return ((x >>> i) & 1) !== 0;
}

/** Encode `str` to UTF-8 bytes (Nayuki ports this by hand; we use the platform encoder). */
function toUtf8Bytes(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

function isNumeric(text: string): boolean {
  return NUMERIC_REGEX.test(text);
}

function isAlphanumeric(text: string): boolean {
  return ALPHANUMERIC_REGEX.test(text);
}

/** Build a byte-mode segment from raw bytes. */
function makeBytesSegment(bytes: Uint8Array): QrSegment {
  const bits: number[] = [];
  for (const b of bytes) {
    appendBits(b, 8, bits);
  }
  return { mode: MODE_BYTE, numChars: bytes.length, bits };
}

/** Build a numeric-mode segment (3 digits -> 10 bits, etc.). */
function makeNumericSegment(digits: string): QrSegment {
  const bits: number[] = [];
  for (let i = 0; i < digits.length; ) {
    const n = Math.min(digits.length - i, 3);
    appendBits(Number.parseInt(digits.substring(i, i + n), 10), n * 3 + 1, bits);
    i += n;
  }
  return { mode: MODE_NUMERIC, numChars: digits.length, bits };
}

/** Build an alphanumeric-mode segment (2 chars -> 11 bits, trailing char -> 6 bits). */
function makeAlphanumericSegment(text: string): QrSegment {
  const bits: number[] = [];
  let i: number;
  for (i = 0; i + 2 <= text.length; i += 2) {
    const pair =
      ALPHANUMERIC_CHARSET.indexOf(text.charAt(i)) * 45 +
      ALPHANUMERIC_CHARSET.indexOf(text.charAt(i + 1));
    appendBits(pair, 11, bits);
  }
  if (i < text.length) {
    appendBits(ALPHANUMERIC_CHARSET.indexOf(text.charAt(i)), 6, bits);
  }
  return { mode: MODE_ALPHANUMERIC, numChars: text.length, bits };
}

/**
 * Select the most efficient single-segment encoding for `text`, exactly as Nayuki's
 * `makeSegments`: numeric if all digits, else alphanumeric if in the charset, else
 * UTF-8 byte mode. Empty text -> no segments.
 */
function makeSegments(text: string): readonly QrSegment[] {
  if (text === "") {
    return [];
  }
  if (isNumeric(text)) {
    return [makeNumericSegment(text)];
  }
  if (isAlphanumeric(text)) {
    return [makeAlphanumericSegment(text)];
  }
  return [makeBytesSegment(toUtf8Bytes(text))];
}

/** Total encoded bit length of `segs` at `version`, or `Infinity` if a count overflows. */
function getTotalBits(segs: readonly QrSegment[], version: number): number {
  let result = 0;
  for (const seg of segs) {
    const ccbits = charCountBits(seg.mode, version);
    if (seg.numChars >= 1 << ccbits) {
      return Number.POSITIVE_INFINITY;
    }
    result += 4 + ccbits + seg.bits.length;
  }
  return result;
}

/** Raw data-module count for `version` (includes remainder bits). */
function getNumRawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) {
      result -= 36;
    }
  }
  return result;
}

/** Number of 8-bit data codewords for `version` + `ecc` (raw minus ECC). */
function getNumDataCodewords(version: number, ecc: EccSpec): number {
  return (
    Math.floor(getNumRawDataModules(version) / 8) -
    eccTableCell(ECC_CODEWORDS_PER_BLOCK, ecc.ordinal, version) *
      eccTableCell(NUM_ERROR_CORRECTION_BLOCKS, ecc.ordinal, version)
  );
}

/** Multiply two GF(2^8 / 0x11D) field elements (Russian-peasant multiplication). */
function reedSolomonMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** Reed-Solomon generator polynomial of the given degree (coefficients high -> low). */
function reedSolomonComputeDivisor(degree: number): Uint8Array {
  if (degree < 1 || degree > 255) {
    throw new Error(`qr: RS degree out of range (${degree})`);
  }
  const result = new Uint8Array(degree);
  result[degree - 1] = 1; // start off with the monomial x^0
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = reedSolomonMultiply(result[j] ?? 0, root);
      if (j + 1 < result.length) {
        result[j] = (result[j] ?? 0) ^ (result[j + 1] ?? 0);
      }
    }
    root = reedSolomonMultiply(root, 0x02);
  }
  return result;
}

/** Reed-Solomon remainder (the ECC codewords) of `data` over `divisor`. */
function reedSolomonComputeRemainder(data: Uint8Array, divisor: Uint8Array): Uint8Array {
  const result = new Uint8Array(divisor.length);
  for (const b of data) {
    const factor = b ^ (result[0] ?? 0);
    result.copyWithin(0, 1); // shift left by one
    result[result.length - 1] = 0;
    for (let i = 0; i < divisor.length; i++) {
      result[i] = (result[i] ?? 0) ^ reedSolomonMultiply(divisor[i] ?? 0, factor);
    }
  }
  return result;
}

/**
 * The in-construction QR symbol: the dark/light grid plus a parallel `isFunction`
 * grid marking modules excluded from masking. This mirrors Nayuki's `QrCode` class
 * but as a plain struct the encoder builds and then freezes into a {@link QrMatrix}.
 * Both grids are `Uint8Array` (0/1) so cell access is total and assertion-free.
 */
interface QrBuild {
  readonly version: number;
  readonly ecc: EccSpec;
  readonly size: number;
  /** Row-major dark/light (1 = dark), `modules[y * size + x]`. */
  readonly modules: Uint8Array;
  /** Row-major function-module mask (1 = not subject to data masking). */
  readonly isFunction: Uint8Array;
}

function idx(build: QrBuild, x: number, y: number): number {
  return y * build.size + x;
}

function setFunctionModule(build: QrBuild, x: number, y: number, isDark: boolean): void {
  const at = idx(build, x, y);
  build.modules[at] = isDark ? 1 : 0;
  build.isFunction[at] = 1;
}

/** Positions of alignment-pattern centers for `version` (empty for version 1). */
function getAlignmentPatternPositions(version: number, size: number): number[] {
  if (version === 1) {
    return [];
  }
  const numAlign = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
  const result: number[] = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) {
    result.splice(1, 0, pos);
  }
  return result;
}

function drawFinderPattern(build: QrBuild, x: number, y: number): void {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      const xx = x + dx;
      const yy = y + dy;
      if (xx >= 0 && xx < build.size && yy >= 0 && yy < build.size) {
        setFunctionModule(build, xx, yy, dist !== 2 && dist !== 4);
      }
    }
  }
}

function drawAlignmentPattern(build: QrBuild, x: number, y: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      setFunctionModule(build, x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

function drawFormatBits(build: QrBuild, mask: number): void {
  const data = (build.ecc.formatBits << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) {
    rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  }
  const bits = ((data << 10) | rem) ^ 0x5412;

  for (let i = 0; i <= 5; i++) {
    setFunctionModule(build, 8, i, getBit(bits, i));
  }
  setFunctionModule(build, 8, 7, getBit(bits, 6));
  setFunctionModule(build, 8, 8, getBit(bits, 7));
  setFunctionModule(build, 7, 8, getBit(bits, 8));
  for (let i = 9; i < 15; i++) {
    setFunctionModule(build, 14 - i, 8, getBit(bits, i));
  }

  for (let i = 0; i < 8; i++) {
    setFunctionModule(build, build.size - 1 - i, 8, getBit(bits, i));
  }
  for (let i = 8; i < 15; i++) {
    setFunctionModule(build, 8, build.size - 15 + i, getBit(bits, i));
  }
  setFunctionModule(build, 8, build.size - 8, true);
}

function drawVersion(build: QrBuild): void {
  if (build.version < 7) {
    return;
  }
  let rem = build.version;
  for (let i = 0; i < 12; i++) {
    rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  }
  const bits = (build.version << 12) | rem;

  for (let i = 0; i < 18; i++) {
    const color = getBit(bits, i);
    const a = build.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    setFunctionModule(build, a, b, color);
    setFunctionModule(build, b, a, color);
  }
}

function drawFunctionPatterns(build: QrBuild): void {
  for (let i = 0; i < build.size; i++) {
    setFunctionModule(build, 6, i, i % 2 === 0);
    setFunctionModule(build, i, 6, i % 2 === 0);
  }

  drawFinderPattern(build, 3, 3);
  drawFinderPattern(build, build.size - 4, 3);
  drawFinderPattern(build, 3, build.size - 4);

  const alignPos = getAlignmentPatternPositions(build.version, build.size);
  const numAlign = alignPos.length;
  for (let i = 0; i < numAlign; i++) {
    for (let j = 0; j < numAlign; j++) {
      const isFinderCorner =
        (i === 0 && j === 0) || (i === 0 && j === numAlign - 1) || (i === numAlign - 1 && j === 0);
      if (!isFinderCorner) {
        const px = alignPos[i];
        const py = alignPos[j];
        if (px !== undefined && py !== undefined) {
          drawAlignmentPattern(build, px, py);
        }
      }
    }
  }

  drawFormatBits(build, 0);
  drawVersion(build);
}

/** Append ECC codewords to each block, then interleave blocks into the final stream. */
function addEccAndInterleave(build: QrBuild, data: Uint8Array): Uint8Array {
  const ver = build.version;
  const ecl = build.ecc;
  const numBlocks = eccTableCell(NUM_ERROR_CORRECTION_BLOCKS, ecl.ordinal, ver);
  const blockEccLen = eccTableCell(ECC_CODEWORDS_PER_BLOCK, ecl.ordinal, ver);
  const rawCodewords = Math.floor(getNumRawDataModules(ver) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  // Each block holds shortBlockLen (or +1) bytes once ECC is appended. We store the
  // padded short blocks as full-length rows and skip the padding byte on interleave.
  const blocks: Uint8Array[] = [];
  const rsDiv = reedSolomonComputeDivisor(blockEccLen);
  let k = 0;
  for (let i = 0; i < numBlocks; i++) {
    const datLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
    const dat = data.subarray(k, k + datLen);
    k += datLen;
    const ecc = reedSolomonComputeRemainder(dat, rsDiv);
    // block = data bytes (with a trailing 0 pad for short blocks) + ecc bytes.
    const isShort = i < numShortBlocks;
    const block = new Uint8Array(datLen + (isShort ? 1 : 0) + blockEccLen);
    block.set(dat, 0);
    block.set(ecc, datLen + (isShort ? 1 : 0));
    blocks.push(block);
  }

  const longestBlock = shortBlockLen + 1;
  const result = new Uint8Array(rawCodewords);
  let w = 0;
  for (let i = 0; i < longestBlock; i++) {
    for (let j = 0; j < blocks.length; j++) {
      const block = blocks[j];
      if (block === undefined) {
        continue;
      }
      // Skip the padding byte in short blocks (it sits at index shortBlockLen-blockEccLen).
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) {
        if (i < block.length) {
          result[w] = block[i] ?? 0;
          w++;
        }
      }
    }
  }
  return result;
}

/** Lay the interleaved codeword stream onto the grid in the zigzag scan order. */
function drawCodewords(build: QrBuild, data: Uint8Array): void {
  let i = 0;
  const totalBits = data.length * 8;
  for (let right = build.size - 1; right >= 1; right -= 2) {
    if (right === 6) {
      right = 5;
    }
    for (let vert = 0; vert < build.size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? build.size - 1 - vert : vert;
        const at = idx(build, x, y);
        if (build.isFunction[at] === 0 && i < totalBits) {
          build.modules[at] = getBit(data[i >>> 3] ?? 0, 7 - (i & 7)) ? 1 : 0;
          i++;
        }
      }
    }
  }
}

/** Whether mask `mask` inverts the module at `(x, y)` (the 8 standard mask rules). */
function maskInverts(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      throw new Error(`qr: invalid mask ${mask}`);
  }
}

/** XOR `mask` over the non-function modules (calling twice with same mask undoes it). */
function applyMask(build: QrBuild, mask: number): void {
  for (let y = 0; y < build.size; y++) {
    for (let x = 0; x < build.size; x++) {
      const at = idx(build, x, y);
      if (build.isFunction[at] === 0 && maskInverts(mask, x, y)) {
        build.modules[at] = (build.modules[at] ?? 0) ^ 1;
      }
    }
  }
}

/** Push a run length onto the finder-pattern history ring (helper for penalty scoring). */
function finderPenaltyAddHistory(size: number, runLength: number, runHistory: number[]): void {
  let len = runLength;
  if (runHistory[0] === 0) {
    len += size;
  }
  runHistory.pop();
  runHistory.unshift(len);
}

/** Count finder-like (1:1:3:1:1) patterns in the run history (0, 1, or 2). */
function finderPenaltyCountPatterns(runHistory: readonly number[]): number {
  const [h0 = 0, n = 0, h2 = 0, h3 = 0, h4 = 0, h5 = 0, h6 = 0] = runHistory;
  const core = n > 0 && h2 === n && h3 === n * 3 && h4 === n && h5 === n;
  return (core && h0 >= n * 4 && h6 >= n ? 1 : 0) + (core && h6 >= n * 4 && h0 >= n ? 1 : 0);
}

/** Terminate a line's run history (add the light border) and count its finder patterns. */
function finderPenaltyTerminateAndCount(
  size: number,
  currentRunColor: boolean,
  currentRunLength: number,
  runHistory: number[],
): number {
  let len = currentRunLength;
  if (currentRunColor) {
    finderPenaltyAddHistory(size, len, runHistory);
    len = 0;
  }
  len += size;
  finderPenaltyAddHistory(size, len, runHistory);
  return finderPenaltyCountPatterns(runHistory);
}

/** Total penalty score of the current modules (lower is better) for mask selection. */
function getPenaltyScore(build: QrBuild): number {
  let result = 0;
  const size = build.size;
  const m = build.modules;

  // Rule 1 (rows) + finder-like patterns.
  for (let y = 0; y < size; y++) {
    let runColor = 0;
    let runX = 0;
    const runHistory = [0, 0, 0, 0, 0, 0, 0];
    for (let x = 0; x < size; x++) {
      const cell = m[y * size + x] ?? 0;
      if (cell === runColor) {
        runX++;
        if (runX === 5) {
          result += PENALTY_N1;
        } else if (runX > 5) {
          result++;
        }
      } else {
        finderPenaltyAddHistory(size, runX, runHistory);
        if (runColor === 0) {
          result += finderPenaltyCountPatterns(runHistory) * PENALTY_N3;
        }
        runColor = cell;
        runX = 1;
      }
    }
    result += finderPenaltyTerminateAndCount(size, runColor !== 0, runX, runHistory) * PENALTY_N3;
  }

  // Rule 1 (columns) + finder-like patterns.
  for (let x = 0; x < size; x++) {
    let runColor = 0;
    let runY = 0;
    const runHistory = [0, 0, 0, 0, 0, 0, 0];
    for (let y = 0; y < size; y++) {
      const cell = m[y * size + x] ?? 0;
      if (cell === runColor) {
        runY++;
        if (runY === 5) {
          result += PENALTY_N1;
        } else if (runY > 5) {
          result++;
        }
      } else {
        finderPenaltyAddHistory(size, runY, runHistory);
        if (runColor === 0) {
          result += finderPenaltyCountPatterns(runHistory) * PENALTY_N3;
        }
        runColor = cell;
        runY = 1;
      }
    }
    result += finderPenaltyTerminateAndCount(size, runColor !== 0, runY, runHistory) * PENALTY_N3;
  }

  // Rule 2: 2x2 blocks of same color.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const color = m[y * size + x];
      if (
        color === m[y * size + x + 1] &&
        color === m[(y + 1) * size + x] &&
        color === m[(y + 1) * size + x + 1]
      ) {
        result += PENALTY_N2;
      }
    }
  }

  // Rule 4: dark/light balance.
  let dark = 0;
  for (const cell of m) {
    dark += cell;
  }
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  result += k * PENALTY_N4;
  return result;
}

/** Allocate a fresh `version`-sized build and draw its function patterns. */
function createBuild(version: number, ecc: EccSpec): QrBuild {
  const size = version * 4 + 17;
  const cells = size * size;
  const build: QrBuild = {
    version,
    ecc,
    size,
    modules: new Uint8Array(cells),
    isFunction: new Uint8Array(cells),
  };
  drawFunctionPatterns(build);
  return build;
}

/**
 * Encode `text` into a QR code matrix.
 *
 * Picks the smallest version that fits `text` at the requested ECC level (then boosts
 * the ECC level for free if the data still fits), lays out the data + Reed-Solomon ECC,
 * and selects the mask with the lowest standard penalty score — fully deterministically.
 *
 * @param text - The payload (URL, token, etc.). Empty string is allowed.
 * @param opts - Encoding options; `ecc` defaults to `"M"`.
 * @returns An immutable {@link QrMatrix} (row-major, `true` = dark).
 * @throws Error if `text` is too long to fit in the largest QR version (40) at `ecc`.
 */
export function encodeQr(text: string, opts?: EncodeQrOptions): QrMatrix {
  const requestedEcc = opts?.ecc ?? "M";
  let eccSpec = ECC_SPECS[requestedEcc];

  const segs = makeSegments(text);

  // Find the smallest version that fits the data at the requested ECC level.
  let version = MIN_VERSION;
  let dataUsedBits = 0;
  for (;;) {
    const capacityBits = getNumDataCodewords(version, eccSpec) * 8;
    const usedBits = getTotalBits(segs, version);
    if (usedBits <= capacityBits) {
      dataUsedBits = usedBits;
      break;
    }
    if (version >= MAX_VERSION) {
      throw new Error(
        `qr: data too long to fit in any QR version at ECC ${requestedEcc} (${text.length} chars)`,
      );
    }
    version++;
  }

  // Boost the ECC level for free while the data still fits this version.
  for (const candidate of ECC_BOOST_ORDER) {
    const candidateSpec = ECC_SPECS[candidate];
    if (dataUsedBits <= getNumDataCodewords(version, candidateSpec) * 8) {
      eccSpec = candidateSpec;
    }
  }

  // Build the data bit stream: mode + char-count + payload bits per segment.
  const bb: number[] = [];
  for (const seg of segs) {
    appendBits(seg.mode.modeBits, 4, bb);
    appendBits(seg.numChars, charCountBits(seg.mode, version), bb);
    for (const b of seg.bits) {
      bb.push(b);
    }
  }

  // Terminator + byte padding + alternating pad bytes up to capacity.
  const capacityBits = getNumDataCodewords(version, eccSpec) * 8;
  appendBits(0, Math.min(4, capacityBits - bb.length), bb);
  appendBits(0, (8 - (bb.length % 8)) % 8, bb);
  for (let padByte = 0xec; bb.length < capacityBits; padByte ^= 0xec ^ 0x11) {
    appendBits(padByte, 8, bb);
  }

  // Pack bits into big-endian data codewords.
  const dataCodewords = new Uint8Array(bb.length >>> 3);
  for (let i = 0; i < bb.length; i++) {
    const ci = i >>> 3;
    dataCodewords[ci] = (dataCodewords[ci] ?? 0) | ((bb[i] ?? 0) << (7 - (i & 7)));
  }

  // Construct the symbol: ECC + interleave, draw codewords, choose the best mask.
  const build = createBuild(version, eccSpec);
  const allCodewords = addEccAndInterleave(build, dataCodewords);
  drawCodewords(build, allCodewords);

  let bestMask = 0;
  let minPenalty = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(build, mask);
    drawFormatBits(build, mask);
    const penalty = getPenaltyScore(build);
    if (penalty < minPenalty) {
      bestMask = mask;
      minPenalty = penalty;
    }
    applyMask(build, mask); // undo (XOR is its own inverse)
  }
  applyMask(build, bestMask);
  drawFormatBits(build, bestMask);

  const modules: boolean[] = new Array<boolean>(build.modules.length);
  for (let i = 0; i < build.modules.length; i++) {
    modules[i] = build.modules[i] !== 0;
  }
  return { size: build.size, modules };
}

/** Read the module at `(x, y)`; out-of-range is treated as light (`false`). */
export function readModule(matrix: QrMatrix, x: number, y: number): boolean {
  if (x < 0 || x >= matrix.size || y < 0 || y >= matrix.size) {
    return false;
  }
  return matrix.modules[y * matrix.size + x] === true;
}
