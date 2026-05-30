/// <reference lib="dom" />
import { seededUnit } from "../world/hash.ts";
import type { Inhabitant, SceneGraph } from "../world/types.ts";
import { resolveMark } from "./brand/index.ts";
import { drawSprite, SPRITE_W, type Sprite, spriteFor } from "./sprite.ts";

// Hearth-Cottage palette.
const HEARTH_WALL = "#3a2a22";
const LAMPLIT_WOOD = "#6b4a35";
const WARM_PLASTER = "#c89a6a";
const FIRELIGHT = "#ffb454";
const EMBER_GOLD = "#ffd98a";
const RUG_ROSE = "#a8504a";
const DUSK_WINDOW = "#5a6b8c";
const CREAM = "#fff4e2";

/** Mood -> soft under-glow RGB (all warm + gentle; error is rose, never red-alarm). */
const MOOD_GLOW: Record<string, string> = {
  ok: "255, 180, 84",
  no_change: "120, 150, 190",
  idle: "150, 130, 110",
  error: "168, 80, 74",
  working: "255, 217, 138",
};

export interface HitRegion {
  readonly id: string;
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
}

export interface RenderOpts {
  readonly hoverId: string | null;
  readonly workingIds: ReadonlySet<string>;
  /** id -> performance.now() of a recent run, for the celebratory spark puff. */
  readonly pops: ReadonlyMap<string, number>;
  /** Honor prefers-reduced-motion: a near-still, fully-legible scene. */
  readonly reducedMotion: boolean;
}

const spriteCache = new Map<number, Sprite>();
function getSprite(seed: number): Sprite {
  let s = spriteCache.get(seed);
  if (s === undefined) {
    s = spriteFor(seed);
    spriteCache.set(seed, s);
  }
  return s;
}

// The static room is baked once per (size, seed) — a net 60fps win over redrawing it.
let roomCache: { key: string; canvas: HTMLCanvasElement } | null = null;
function room(w: number, h: number, seed: string): HTMLCanvasElement {
  const key = `${w}x${h}:${seed}`;
  if (roomCache !== null && roomCache.key === key) return roomCache.canvas;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, w);
  canvas.height = Math.max(1, h);
  const rc = canvas.getContext("2d");
  if (rc !== null) bakeRoom(rc, w, h, seed);
  roomCache = { key, canvas };
  return canvas;
}

/** Draw the static cottage interior (everything except the live fire/embers/creatures). */
function bakeRoom(ctx: CanvasRenderingContext2D, w: number, h: number, seed: string): void {
  // Back wall: warm late-afternoon gradient (bright enough for aging eyes — not a dim murk).
  const wall = ctx.createLinearGradient(0, 0, 0, h);
  wall.addColorStop(0, HEARTH_WALL);
  wall.addColorStop(0.55, LAMPLIT_WOOD);
  wall.addColorStop(1, WARM_PLASTER);
  ctx.fillStyle = wall;
  ctx.fillRect(0, 0, w, h);

  // Wooden beams (horizontal plank seams) + corner posts -> reads as "a room".
  ctx.lineWidth = 1;
  for (let i = 1; i <= 4; i++) {
    const y = (h * i) / 6;
    ctx.strokeStyle = "rgba(46, 33, 26, 0.55)";
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    ctx.strokeStyle = "rgba(122, 86, 64, 0.5)";
    ctx.beginPath();
    ctx.moveTo(0, y + 1.5);
    ctx.lineTo(w, y + 1.5);
    ctx.stroke();
  }
  const post = Math.max(8, w * 0.05);
  ctx.fillStyle = "rgba(46, 33, 26, 0.35)";
  ctx.fillRect(0, 0, post, h);
  ctx.fillRect(w - post, 0, post, h);

  // Dusk window upper-right (the single cool note — makes the inside feel sheltered).
  const winW = Math.min(190, w * 0.18);
  const winH = winW * 1.15;
  const wx = w - winW - w * 0.1;
  const wy = h * 0.12;
  const dusk = ctx.createLinearGradient(0, wy, 0, wy + winH);
  dusk.addColorStop(0, DUSK_WINDOW);
  dusk.addColorStop(1, "#7d8db0");
  roundRect(ctx, wx, wy, winW, winH, 10);
  ctx.fillStyle = dusk;
  ctx.fill();
  // Seeded stars + a soft moon.
  ctx.fillStyle = "rgba(255, 244, 226, 0.85)";
  for (let i = 0; i < 6; i++) {
    const sx = wx + 8 + seededUnit(`${seed}:win:${i}:x`) * (winW - 16);
    const sy = wy + 8 + seededUnit(`${seed}:win:${i}:y`) * (winH * 0.6);
    ctx.fillRect(sx, sy, 2, 2);
  }
  ctx.fillStyle = "rgba(255, 248, 230, 0.7)";
  ctx.beginPath();
  ctx.arc(wx + winW * 0.7, wy + winH * 0.3, winW * 0.12, 0, Math.PI * 2);
  ctx.fill();
  // Muntin cross + frame.
  ctx.strokeStyle = LAMPLIT_WOOD;
  ctx.lineWidth = 4;
  roundRect(ctx, wx, wy, winW, winH, 10);
  ctx.stroke();
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(wx + winW / 2, wy);
  ctx.lineTo(wx + winW / 2, wy + winH);
  ctx.moveTo(wx, wy + winH / 2);
  ctx.lineTo(wx + winW, wy + winH / 2);
  ctx.stroke();

  // Floor planks below the rug.
  const floorY = h * 0.82;
  ctx.fillStyle = "#5a3d2c";
  ctx.fillRect(0, floorY, w, h - floorY);
  ctx.strokeStyle = "rgba(46, 33, 26, 0.4)";
  for (let x = 0; x < w; x += Math.max(40, w * 0.08)) {
    ctx.beginPath();
    ctx.moveTo(x, floorY);
    ctx.lineTo(x, h);
    ctx.stroke();
  }

  // Fireplace: stone arch + dark hearth opening, bottom-center.
  const fpW = Math.min(220, w * 0.22);
  const fpX = w / 2 - fpW / 2;
  const fpY = h * 0.6;
  const fpH = h * 0.32;
  ctx.fillStyle = "#4a3328";
  roundRect(ctx, fpX, fpY, fpW, fpH, 14);
  ctx.fill();
  ctx.fillStyle = "#1c120c";
  roundRect(ctx, fpX + fpW * 0.14, fpY + fpH * 0.2, fpW * 0.72, fpH * 0.8, 10);
  ctx.fill();

  // Braided oval rug in front of the fire (the gathering circle).
  const rugCX = w / 2;
  const rugCY = h * 0.78;
  const rugRX = Math.min(w * 0.42, 460);
  const rugRY = rugRX * 0.32;
  for (let i = 5; i >= 0; i--) {
    ctx.beginPath();
    ctx.ellipse(rugCX, rugCY, rugRX * (i / 5), rugRY * (i / 5), 0, 0, Math.PI * 2);
    ctx.fillStyle = i % 2 === 0 ? RUG_ROSE : "#b9695f";
    ctx.fill();
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** The hearth fire: 3 layered flame curves + a cast radial glow. The room's heartbeat. */
function drawFire(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  t: number,
  liveliness: number,
  reduced: boolean,
): void {
  const baseX = w / 2;
  const baseY = h * 0.82;
  const flameH = h * 0.1 * (0.85 + liveliness * 0.4);
  const flicker = reduced ? 1 : 0.85 + 0.15 * Math.sin(t / 120);

  // Cast glow across the lower room.
  const glowR =
    Math.min(w, h) * (0.5 + liveliness * 0.15) * (reduced ? 1 : 0.95 + 0.08 * Math.sin(t / 700));
  const glow = ctx.createRadialGradient(baseX, baseY, 0, baseX, baseY, glowR);
  glow.addColorStop(0, "rgba(255, 180, 84, 0.5)");
  glow.addColorStop(0.5, "rgba(255, 160, 70, 0.16)");
  glow.addColorStop(1, "rgba(255, 160, 70, 0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(baseX, baseY, glowR, 0, Math.PI * 2);
  ctx.fill();

  const flames: Array<[number, string, number]> = [
    [flameH * 1.0, RUG_ROSE, 0.9],
    [flameH * 0.8, FIRELIGHT, 1.0],
    [flameH * 0.55, EMBER_GOLD, 1.0],
  ];
  for (const [fh, color, wob] of flames) {
    const sway = reduced ? 0 : Math.sin(t / 90 + fh) * 4 * wob;
    const tipX = baseX + sway;
    const tipY = baseY - fh * flicker;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(baseX - fh * 0.3, baseY);
    ctx.quadraticCurveTo(baseX - fh * 0.25, baseY - fh * 0.5, tipX, tipY);
    ctx.quadraticCurveTo(baseX + fh * 0.25, baseY - fh * 0.5, baseX + fh * 0.3, baseY);
    ctx.closePath();
    ctx.fill();
  }

  // Rising embers (capped; scales with liveliness; off under reduced-motion).
  if (!reduced) {
    const embers = Math.min(8, Math.round(2 + liveliness * 6));
    ctx.fillStyle = "rgba(255, 200, 120, 0.7)";
    for (let i = 0; i < embers; i++) {
      const phase = (t / 2600 + i / embers) % 1;
      const ex = baseX + Math.sin(t / 800 + i * 2) * w * 0.04;
      const ey = baseY - phase * h * 0.22;
      ctx.globalAlpha = 0.7 * (1 - phase);
      ctx.fillRect(ex, ey, 2, 2);
    }
    ctx.globalAlpha = 1;
  }
}

/** Draw the whole cottage scene and return click/hover hit regions. */
export function drawScene(
  ctx: CanvasRenderingContext2D,
  scene: SceneGraph,
  w: number,
  h: number,
  t: number,
  opts: RenderOpts,
): HitRegion[] {
  ctx.drawImage(room(w, h, scene.seed), 0, 0, w, h);
  drawFire(ctx, w, h, t, scene.liveliness, opts.reducedMotion);

  const base = Math.max(5, Math.min(13, Math.min(w, h) / 60));
  const hits: HitRegion[] = [];

  for (const inh of scene.inhabitants) {
    const working = opts.workingIds.has(inh.id);
    const pixel = Math.max(4, Math.round(base * (0.78 + 0.5 * inh.prominence)));
    const footprint = SPRITE_W * pixel;

    const cx = (0.12 + inh.x * 0.76) * w;
    const baseY = clamp(
      (inh.live ? 0.42 + inh.y * 0.45 : 0.5 + inh.y * 0.34) * h,
      h * 0.42,
      h * 0.86,
    );
    const phase = inh.avatarSeed % 1000;
    const period = working ? 300 : inh.live ? 600 : 1100;
    const amp = working ? 5 : inh.live ? 4 : 3;
    const bob = opts.reducedMotion ? 0 : Math.sin(t / period + phase) * amp;
    const cy = baseY + bob;

    const moodKey = working ? "working" : inh.mood;
    const rgb = MOOD_GLOW[moodKey] ?? MOOD_GLOW.idle;
    const intensity = working ? 0.42 : inh.live ? 0.34 : inh.mood === "idle" ? 0.14 : 0.3;

    // Soft floor shadow.
    ctx.fillStyle = "rgba(28, 18, 12, 0.3)";
    ctx.beginPath();
    ctx.ellipse(cx, baseY + footprint * 0.46, footprint * 0.34, footprint * 0.1, 0, 0, Math.PI * 2);
    ctx.fill();

    // Mood under-glow.
    const glowR = footprint * 0.9;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
    g.addColorStop(0, `rgba(${rgb}, ${intensity})`);
    g.addColorStop(1, `rgba(${rgb}, 0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, glowR, 0, Math.PI * 2);
    ctx.fill();

    if (inh.live) {
      drawLantern(ctx, inh, cx, cy, footprint, t, opts.reducedMotion);
    }

    // Run "pop" — a warm ember spark puff.
    const pop = opts.pops.get(inh.id);
    if (pop !== undefined) {
      const age = t - pop;
      if (age >= 0 && age < 720) {
        const p = age / 720;
        ctx.fillStyle = `rgba(255, 217, 138, ${(1 - p) * 0.9})`;
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2;
          const rr = footprint * 0.4 + p * footprint * 0.7;
          ctx.fillRect(
            cx + Math.cos(a) * rr,
            cy - p * footprint * 0.6 + Math.sin(a) * rr * 0.4,
            3,
            3,
          );
        }
      }
    }

    // Working sparkle — a couple of ember dots orbiting.
    if (working && !opts.reducedMotion) {
      ctx.fillStyle = "rgba(255, 217, 138, 0.9)";
      for (let i = 0; i < 2; i++) {
        const a = t / 280 + i * Math.PI;
        ctx.fillRect(cx + Math.cos(a) * footprint * 0.5, cy + Math.sin(a) * footprint * 0.5, 3, 3);
      }
    }

    drawSprite(ctx, getSprite(inh.avatarSeed), cx, cy, pixel);

    // Gentle "needs a look" — a soft "?" tuft + a color-INDEPENDENT worded chip
    // (aging / color-vision-impaired eyes must not miss the one state that matters).
    if (!inh.live && inh.mood === "error") {
      ctx.fillStyle = CREAM;
      ctx.font = `bold ${Math.max(14, Math.round(pixel * 1.8))}px Georgia, serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      ctx.fillText("?", cx, cy - footprint * 0.6);
      drawChip(ctx, "needs a look", cx, cy - footprint * 0.42);
    }

    // Nameplate (warm cream sans, normal case).
    const hovered = opts.hoverId === inh.id;
    ctx.font = `${Math.max(13, Math.round(pixel * 1.4))}px "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = hovered ? CREAM : "rgba(255, 244, 226, 0.82)";
    ctx.fillText(inh.label, cx, cy + footprint * 0.55);

    hits.push({ id: inh.id, cx, cy, r: footprint * 0.62 });
  }

  return hits;
}

/** A live visitor carries a small lantern; the lantern shows the agent's brand mark. */
function drawLantern(
  ctx: CanvasRenderingContext2D,
  inh: Inhabitant,
  cx: number,
  cy: number,
  footprint: number,
  t: number,
  reduced: boolean,
): void {
  const lx = cx - footprint * 0.62;
  const ly = cy;
  const r = footprint * 0.26;
  const breathe = reduced ? 1 : 0.85 + 0.15 * Math.sin(t / 600 + (inh.avatarSeed % 100));

  // Warm lantern pool.
  const pool = ctx.createRadialGradient(lx, ly, 0, lx, ly, r * 2.2);
  pool.addColorStop(0, `rgba(255, 200, 120, ${0.45 * breathe})`);
  pool.addColorStop(1, "rgba(255, 200, 120, 0)");
  ctx.fillStyle = pool;
  ctx.beginPath();
  ctx.arc(lx, ly, r * 2.2, 0, Math.PI * 2);
  ctx.fill();

  // Lantern body + glass.
  ctx.fillStyle = "#4a3328";
  roundRect(ctx, lx - r * 0.7, ly - r, r * 1.4, r * 2, r * 0.3);
  ctx.fill();
  ctx.fillStyle = `rgba(255, 220, 150, ${0.85 * breathe})`;
  roundRect(ctx, lx - r * 0.5, ly - r * 0.75, r, r * 1.5, r * 0.25);
  ctx.fill();

  // Brand mark on the lantern glass — resolveMark is total (never null), so a live
  // visitor ALWAYS shows its real logo (unknown agents get the Vesper default).
  const mark = resolveMark(inh.id);
  mark.draw(ctx, lx, ly, r * 0.55);
  // A tiny brand-colored dot above so it reads even at a glance.
  ctx.fillStyle = mark.color;
  ctx.fillRect(lx - 2, ly - r * 1.4, 4, 4);
}

/** A small rounded pill with plain-language text — readable without tapping. */
function drawChip(ctx: CanvasRenderingContext2D, text: string, cx: number, cy: number): void {
  ctx.font = `600 13px "Segoe UI", system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const padX = 10;
  const wText = ctx.measureText(text).width;
  const w = wText + padX * 2;
  const hh = 22;
  ctx.fillStyle = "rgba(168, 80, 74, 0.92)";
  roundRect(ctx, cx - w / 2, cy - hh, w, hh, hh / 2);
  ctx.fill();
  ctx.fillStyle = CREAM;
  ctx.fillText(text, cx, cy - hh / 2);
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
