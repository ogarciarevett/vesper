import { seededUnit } from "../world/hash.ts";

/** Sprite grid dimensions (odd width => a clean mirror axis). */
export const SPRITE_W = 9;
export const SPRITE_H = 9;

/**
 * A deterministic little WOOLEN companion — a knitted hearth-creature (felt
 * cat/owl/bun feel), not a cold pixel blob. Same seed => same creature.
 */
export interface Sprite {
  readonly cells: readonly (readonly boolean[])[]; // [H][W], left/right mirrored
  readonly body: string; // wool base
  readonly bodyLight: string; // top-lit band
  readonly bodyEdge: string; // warm brown felt edge
  readonly eye: string; // sleepy dark-brown eye
  readonly catchlight: string; // ember-gold eye glint
  readonly rim: string; // ember-gold fire-facing rim light
  readonly stipple: readonly (readonly [number, number])[]; // knit flecks (cell coords)
}

const cx0 = (SPRITE_W - 1) / 2;
const cy0 = (SPRITE_H - 1) / 2;

/** Hearth wheel: warm seeded hue bands (amber/tan/rust, soft sage, dusty mauve). */
function woolHue(s: string): number {
  const pick = seededUnit(`${s}:band`);
  const t = seededUnit(`${s}:hue`);
  if (pick < 0.6) return 18 + t * (55 - 18); // amber / tan / rust (most common)
  if (pick < 0.82) return 95 + t * (130 - 95); // soft sage
  return 320 + t * (350 - 320); // dusty mauve
}

/**
 * Generate a stable wool creature for a seed: a soft elliptical body + seeded
 * ears/tufts/paws (mirrored), a constrained warm palette (low saturation so it
 * reads as felt, never neon), a warm-brown felt edge, and seeded knit flecks.
 */
export function spriteFor(seed: number): Sprite {
  const s = String(seed);
  const hue = Math.round(woolHue(s));
  const sat = 30 + Math.round(seededUnit(`${s}:sat`) * 15); // 30-45%
  const light = 58 + Math.round(seededUnit(`${s}:light`) * 10); // 58-68%
  const body = `hsl(${hue}, ${sat}%, ${light}%)`;
  const bodyLight = `hsl(${hue}, ${sat}%, ${Math.min(88, light + 12)}%)`;
  const bodyEdge = "#3a2a22"; // warm dark brown felt edge — NOT a hue-derived dark
  const eye = "#2e211a";
  const catchlight = "#ffd98a";
  const rim = "#ffce7a";

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

  // Seeded knit flecks: a handful of filled cells get a darker stipple dot.
  const stipple: [number, number][] = [];
  for (let y = 1; y < SPRITE_H - 1; y++) {
    for (let x = 1; x < SPRITE_W - 1; x++) {
      if (cells[y]?.[x] === true && seededUnit(`${s}:knit:${x}:${y}`) < 0.16) {
        stipple.push([x, y]);
      }
    }
  }

  return { cells, body, bodyLight, bodyEdge, eye, catchlight, rim, stipple };
}

/** Draw a wool sprite centered at (cx, cy) with the given pixel size. */
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

  // 1) Solid wool body.
  ctx.fillStyle = sprite.body;
  for (let y = 0; y < SPRITE_H; y++) {
    for (let x = 0; x < SPRITE_W; x++) {
      if (filled(x, y)) ctx.fillRect(x0 + x * pixel, y0 + y * pixel, pixel, pixel);
    }
  }

  // 2) Top highlight — lighter band where the cell above is empty (soft daylight).
  const hi = Math.max(1, Math.round(pixel * 0.26));
  ctx.fillStyle = sprite.bodyLight;
  for (let y = 0; y < SPRITE_H; y++) {
    for (let x = 0; x < SPRITE_W; x++) {
      if (filled(x, y) && !filled(x, y - 1))
        ctx.fillRect(x0 + x * pixel, y0 + y * pixel, pixel, hi);
    }
  }

  // 3) Knit flecks — a darker stipple dot inside seeded cells (hand-knitted texture).
  const fleck = Math.max(1, Math.round(pixel * 0.3));
  ctx.fillStyle = "rgba(58, 42, 34, 0.35)";
  for (const [x, y] of sprite.stipple) {
    ctx.fillRect(
      x0 + x * pixel + Math.round((pixel - fleck) / 2),
      y0 + y * pixel + Math.round((pixel - fleck) / 2),
      fleck,
      fleck,
    );
  }

  // 4) Warm-brown felt outline on edges facing empty space.
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

  // 5) Ember rim-light on the fire-facing (bottom-left) edge cells.
  ctx.fillStyle = sprite.rim;
  for (let y = 0; y < SPRITE_H; y++) {
    for (let x = 0; x < SPRITE_W; x++) {
      if (!filled(x, y)) continue;
      const px = x0 + x * pixel;
      const py = y0 + y * pixel;
      if (!filled(x - 1, y) && !filled(x, y + 1)) ctx.fillRect(px, py + pixel - ow, ow, ow); // bottom-left corner glow
    }
  }

  // 6) Sleepy eyes — soft dark-brown dots with an ember catchlight.
  const eyeY = y0 + 3 * pixel;
  const inset = Math.max(1, Math.round(pixel * 0.18));
  for (const ex of [x0 + 2 * pixel, x0 + (SPRITE_W - 3) * pixel]) {
    ctx.fillStyle = sprite.eye;
    ctx.fillRect(ex, eyeY, pixel, pixel);
    ctx.fillStyle = sprite.catchlight;
    ctx.fillRect(
      ex + inset,
      eyeY + inset,
      Math.max(1, Math.round(pixel * 0.28)),
      Math.max(1, Math.round(pixel * 0.28)),
    );
  }
}
