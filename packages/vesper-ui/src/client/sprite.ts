import { seededUnit } from "../world/hash.ts";

/** Sprite grid dimensions (odd width => a clean mirror axis). */
export const SPRITE_W = 9;
export const SPRITE_H = 9;

/** A deterministic little pixel creature: a filled-cell mask + a seeded palette. */
export interface Sprite {
  readonly cells: readonly (readonly boolean[])[]; // [H][W], left/right mirrored
  readonly body: string;
  readonly bodyLight: string;
  readonly bodyEdge: string;
  readonly eye: string;
}

const cx0 = (SPRITE_W - 1) / 2;
const cy0 = (SPRITE_H - 1) / 2;

/**
 * Generate a stable creature for an agent seed: a solid elliptical body plus
 * seeded "extremities" (antennae / ears / feet), mirrored for symmetry, with a
 * hue-rotated palette. Same seed always yields the same creature.
 */
export function spriteFor(seed: number): Sprite {
  const s = String(seed);
  const hue = Math.floor(seededUnit(`${s}:hue`) * 360);
  const body = `hsl(${hue}, 70%, 62%)`;
  const bodyLight = `hsl(${hue}, 80%, 76%)`;
  const bodyEdge = `hsl(${hue}, 55%, 30%)`;
  const eye = `hsl(${(hue + 185) % 360}, 92%, 74%)`;

  const half = Math.ceil(SPRITE_W / 2);
  const cells: boolean[][] = [];
  for (let y = 0; y < SPRITE_H; y++) {
    const row = new Array<boolean>(SPRITE_W).fill(false);
    for (let x = 0; x < half; x++) {
      const ellipse = ((x - cx0) / 3.1) ** 2 + ((y - cy0) / 3.7) ** 2 <= 1;
      const onEdgeRow = y < 2 || y > SPRITE_H - 3 || x < 2;
      const extremity = onEdgeRow && seededUnit(`${s}:${x}:${y}`) < 0.55;
      const on = ellipse || extremity;
      row[x] = on;
      row[SPRITE_W - 1 - x] = on;
    }
    cells.push(row);
  }
  return { cells, body, bodyLight, bodyEdge, eye };
}

/** Draw a sprite centered at (cx, cy) with the given pixel size. */
export function drawSprite(
  ctx: CanvasRenderingContext2D,
  sprite: Sprite,
  cx: number,
  cy: number,
  pixel: number,
): void {
  const x0 = Math.round(cx - (SPRITE_W * pixel) / 2);
  const y0 = Math.round(cy - (SPRITE_H * pixel) / 2);
  const cells = sprite.cells;
  const filled = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < SPRITE_W && y < SPRITE_H && cells[y]?.[x] === true;

  // 1) Solid body fill.
  ctx.fillStyle = sprite.body;
  for (let y = 0; y < SPRITE_H; y++) {
    for (let x = 0; x < SPRITE_W; x++) {
      if (filled(x, y)) ctx.fillRect(x0 + x * pixel, y0 + y * pixel, pixel, pixel);
    }
  }

  // 2) Top highlight — a lighter band on cells whose top neighbor is empty (light from above).
  const hi = Math.max(1, Math.round(pixel * 0.24));
  ctx.fillStyle = sprite.bodyLight;
  for (let y = 0; y < SPRITE_H; y++) {
    for (let x = 0; x < SPRITE_W; x++) {
      if (filled(x, y) && !filled(x, y - 1))
        ctx.fillRect(x0 + x * pixel, y0 + y * pixel, pixel, hi);
    }
  }

  // 3) Crisp silhouette outline — a darker line only on edges facing empty space.
  const ow = Math.max(1, Math.round(pixel * 0.16));
  ctx.fillStyle = sprite.bodyEdge;
  for (let y = 0; y < SPRITE_H; y++) {
    for (let x = 0; x < SPRITE_W; x++) {
      if (!filled(x, y)) continue;
      const px = x0 + x * pixel;
      const py = y0 + y * pixel;
      if (!filled(x, y + 1)) ctx.fillRect(px, py + pixel - ow, pixel, ow); // bottom
      if (!filled(x + 1, y)) ctx.fillRect(px + pixel - ow, py, ow, pixel); // right
      if (!filled(x - 1, y)) ctx.fillRect(px, py, ow, pixel); // left
    }
  }

  // 4) Eyes — symmetric, on the body's middle band, with a soft dark socket.
  const eyeY = y0 + 3 * pixel;
  const inset = Math.max(1, Math.round(pixel * 0.16));
  for (const ex of [x0 + 2 * pixel, x0 + (SPRITE_W - 3) * pixel]) {
    ctx.fillStyle = sprite.bodyEdge;
    ctx.fillRect(ex, eyeY, pixel, pixel);
    ctx.fillStyle = sprite.eye;
    ctx.fillRect(ex + inset, eyeY + inset, pixel - inset * 2, pixel - inset * 2);
  }
}
