/// <reference lib="dom" />
import { seededUnit } from "../../../world/hash.ts";
import type { Inhabitant, SceneGraph } from "../../../world/types.ts";
import { resolveMark } from "../../brand/index.ts";
import type { HitRegion, RenderOpts } from "../../render.ts";
import { drawSprite, SPRITE_W, type Sprite, spriteFor } from "../../sprite.ts";
import { registerTheme } from "../../theme/registry.ts";

/**
 * Theme #2 — "Glass" (light glass / wonderful.ai language). A luminous, airy
 * surface: a soft lavender->blush wash, large blurred atmospheric orbs, a frosted
 * glass floor, and each agent standing on its own frosted glass pad under a pastel
 * mood bloom. Premium and calm — no heavy shadows, depth via translucency + tint.
 *
 * The world MODEL and the brand/logo layer (resolveMark) are shared and frozen;
 * this theme only chooses how to frame them. Positioning mirrors the hearth theme
 * so an agent sits in the same spot regardless of theme.
 */

// Deep charcoal-violet ink for text on the light field.
const INK = "#2a2740";

/** Mood -> pastel bloom RGB, tuned to read softly on a LIGHT background. */
const MOOD_GLOW: Record<string, string> = {
  ok: "124, 92, 255", // violet — the brand accent
  no_change: "94, 200, 216", // teal
  idle: "150, 150, 178", // cool gray
  error: "255, 107, 139", // soft rose (never red-alarm)
  working: "154, 125, 255", // brighter violet
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

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

const spriteCache = new Map<number, Sprite>();
function getSprite(seed: number): Sprite {
  let s = spriteCache.get(seed);
  if (s === undefined) {
    s = spriteFor(seed);
    spriteCache.set(seed, s);
  }
  return s;
}

// The static field (wash + orbs + glass floor) is baked once per (size, seed).
let fieldCache: { key: string; canvas: HTMLCanvasElement } | null = null;
function field(w: number, h: number, seed: string): HTMLCanvasElement {
  const key = `${w}x${h}:${seed}`;
  if (fieldCache !== null && fieldCache.key === key) return fieldCache.canvas;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, w);
  canvas.height = Math.max(1, h);
  const fc = canvas.getContext("2d");
  if (fc !== null) bakeField(fc, w, h, seed);
  fieldCache = { key, canvas };
  return canvas;
}

/** Draw the luminous static field: light wash, atmospheric orbs, frosted floor. */
function bakeField(ctx: CanvasRenderingContext2D, w: number, h: number, seed: string): void {
  // Soft vertical wash: pale violet at top easing into a blush base.
  const wash = ctx.createLinearGradient(0, 0, 0, h);
  wash.addColorStop(0, "#f1f0fe");
  wash.addColorStop(0.5, "#edf1fe");
  wash.addColorStop(1, "#fdecf4");
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, w, h);

  // Large blurred atmospheric orbs — lavender, peach, mint, lilac (the wonderful.ai
  // bloom). A three-stop falloff keeps the cores luminous without hard edges.
  const orbs: ReadonlyArray<readonly [number, number, number, string]> = [
    [0.18, 0.2, 0.66, "196, 178, 255"],
    [0.84, 0.26, 0.54, "255, 196, 168"],
    [0.62, 0.86, 0.64, "168, 232, 208"],
    [0.42, 0.52, 0.4, "214, 196, 255"],
  ];
  for (const [ox, oy, orr, rgb] of orbs) {
    const cx = ox * w;
    const cy = oy * h;
    const rad = orr * Math.max(w, h);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
    g.addColorStop(0, `rgba(${rgb}, 0.6)`);
    g.addColorStop(0.6, `rgba(${rgb}, 0.12)`);
    g.addColorStop(1, `rgba(${rgb}, 0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.fill();
  }

  // A luminous crown — soft light spilling from above lifts the whole scene.
  const crown = ctx.createRadialGradient(w * 0.5, -h * 0.15, 0, w * 0.5, -h * 0.15, h);
  crown.addColorStop(0, "rgba(255, 255, 255, 0.5)");
  crown.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.fillStyle = crown;
  ctx.fillRect(0, 0, w, h);

  // A few faint seeded "glass speckles" for texture (very subtle).
  ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
  for (let i = 0; i < 16; i++) {
    const sx = seededUnit(`${seed}:spk:${i}:x`) * w;
    const sy = seededUnit(`${seed}:spk:${i}:y`) * h * 0.78;
    ctx.fillRect(sx, sy, 2, 2);
  }

  // Frosted glass floor — a translucent shelf with a bright lip the creatures sit on.
  const floorY = h * 0.8;
  const floor = ctx.createLinearGradient(0, floorY, 0, h);
  floor.addColorStop(0, "rgba(255, 255, 255, 0.5)");
  floor.addColorStop(1, "rgba(255, 255, 255, 0.12)");
  ctx.fillStyle = floor;
  ctx.fillRect(0, floorY, w, h - floorY);
  ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
  ctx.fillRect(0, floorY, w, 1.5);

  // Gentle edge vignette to focus the center — premium, never heavy.
  const vig = ctx.createRadialGradient(
    w * 0.5,
    h * 0.5,
    Math.min(w, h) * 0.34,
    w * 0.5,
    h * 0.5,
    Math.max(w, h) * 0.72,
  );
  vig.addColorStop(0, "rgba(120, 110, 165, 0)");
  vig.addColorStop(1, "rgba(120, 110, 165, 0.1)");
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, w, h);
}

/** Slow-drifting light motes — the field's gentle pulse (skipped under reduced motion). */
function drawMotes(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  t: number,
  liveliness: number,
): void {
  const motes = Math.min(10, Math.round(4 + liveliness * 6));
  for (let i = 0; i < motes; i++) {
    const phase = (t / 9000 + i / motes) % 1;
    const mx = (i / motes) * w + Math.sin(t / 2600 + i) * w * 0.04;
    const my = h * 0.78 - phase * h * 0.6;
    ctx.globalAlpha = 0.5 * Math.sin(phase * Math.PI);
    ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
    ctx.beginPath();
    ctx.arc(mx, my, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/** Draw the whole glass scene and return click/hover hit regions. */
export function drawSceneGlass(
  ctx: CanvasRenderingContext2D,
  scene: SceneGraph,
  w: number,
  h: number,
  t: number,
  opts: RenderOpts,
): HitRegion[] {
  ctx.drawImage(field(w, h, scene.seed), 0, 0, w, h);
  if (!opts.reducedMotion) drawMotes(ctx, w, h, t, scene.liveliness);

  const base = Math.max(5, Math.min(13, Math.min(w, h) / 60));
  const hits: HitRegion[] = [];

  for (const inh of scene.inhabitants) {
    const working = opts.workingIds.has(inh.id);
    const pixel = Math.max(4, Math.round(base * (0.78 + 0.5 * inh.prominence)));
    const footprint = SPRITE_W * pixel;
    const sprite = getSprite(inh.avatarSeed);

    const cx = (0.12 + inh.x * 0.76) * w;
    const baseY = clamp(
      (inh.live ? 0.42 + inh.y * 0.45 : 0.5 + inh.y * 0.34) * h,
      h * 0.42,
      h * 0.84,
    );
    const phase = inh.avatarSeed % 1000;
    const period = working ? 300 : inh.live ? 600 : 1100;
    const amp = working ? 5 : inh.live ? 4 : 3;
    const bob = opts.reducedMotion ? 0 : Math.sin(t / period + phase) * amp;
    const cy = baseY + bob;

    const moodKey = working ? "working" : inh.mood;
    const rgb = MOOD_GLOW[moodKey] ?? MOOD_GLOW.idle;
    const intensity = working ? 0.34 : inh.live ? 0.28 : inh.mood === "idle" ? 0.12 : 0.24;

    // Reflection in the glass floor — a faded, mirrored creature. The signature
    // glass touch that settles the pixel companions into the luminous surface.
    const mirrorY = baseY + footprint * 0.42;
    ctx.save();
    ctx.globalAlpha = 0.14;
    ctx.translate(0, 2 * mirrorY);
    ctx.scale(1, -1);
    drawSprite(ctx, sprite, cx, cy, pixel);
    ctx.restore();

    // Frosted glass pad — a glossy puck with a soft cast shadow + bright rim.
    const padW = footprint * 1.05;
    const padH = footprint * 0.34;
    const padY = baseY + footprint * 0.34;
    ctx.fillStyle = "rgba(90, 78, 150, 0.14)";
    ctx.beginPath();
    ctx.ellipse(cx, padY + padH * 0.62, padW * 0.5, padH * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
    const pad = ctx.createLinearGradient(0, padY, 0, padY + padH);
    pad.addColorStop(0, "rgba(255, 255, 255, 0.64)");
    pad.addColorStop(1, "rgba(255, 255, 255, 0.32)");
    roundRect(ctx, cx - padW / 2, padY, padW, padH, padH / 2);
    ctx.fillStyle = pad;
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
    ctx.lineWidth = 1;
    ctx.stroke();
    // Top highlight sliver — the glint that reads as polished glass.
    ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
    ctx.beginPath();
    ctx.ellipse(cx, padY + padH * 0.32, padW * 0.4, padH * 0.18, 0, Math.PI * 1.05, Math.PI * 1.95);
    ctx.stroke();

    // Pastel mood bloom behind the creature.
    const glowR = footprint * 0.95;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
    g.addColorStop(0, `rgba(${rgb}, ${intensity})`);
    g.addColorStop(1, `rgba(${rgb}, 0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, glowR, 0, Math.PI * 2);
    ctx.fill();

    if (inh.live) drawBadge(ctx, inh, cx, cy, footprint);

    // Run "pop" — a soft violet/white spark puff.
    const pop = opts.pops.get(inh.id);
    if (pop !== undefined) {
      const age = t - pop;
      if (age >= 0 && age < 720) {
        const p = age / 720;
        ctx.fillStyle = `rgba(154, 125, 255, ${(1 - p) * 0.9})`;
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2;
          const rr = footprint * 0.4 + p * footprint * 0.7;
          ctx.beginPath();
          ctx.arc(
            cx + Math.cos(a) * rr,
            cy - p * footprint * 0.6 + Math.sin(a) * rr * 0.4,
            2.4,
            0,
            Math.PI * 2,
          );
          ctx.fill();
        }
      }
    }

    // Working sparkle — a couple of violet motes orbiting.
    if (working && !opts.reducedMotion) {
      ctx.fillStyle = "rgba(124, 92, 255, 0.9)";
      for (let i = 0; i < 2; i++) {
        const a = t / 280 + i * Math.PI;
        ctx.beginPath();
        ctx.arc(
          cx + Math.cos(a) * footprint * 0.5,
          cy + Math.sin(a) * footprint * 0.5,
          2.6,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
    }

    drawSprite(ctx, sprite, cx, cy, pixel);

    // Color-INDEPENDENT "needs a look" — a soft "?" + a worded chip.
    if (!inh.live && inh.mood === "error") {
      ctx.fillStyle = "#c0436a";
      ctx.font = `bold ${Math.max(14, Math.round(pixel * 1.8))}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      ctx.fillText("?", cx, cy - footprint * 0.6);
      drawChip(
        ctx,
        "needs a look",
        cx,
        cy - footprint * 0.4,
        "rgba(255, 224, 232, 0.92)",
        "#a8324f",
      );
    }

    // Nameplate — a frosted pill with charcoal ink (legible on the light field).
    const hovered = opts.hoverId === inh.id;
    drawChip(
      ctx,
      inh.label,
      cx,
      baseY + footprint * 0.92,
      hovered ? "rgba(255, 255, 255, 0.92)" : "rgba(255, 255, 255, 0.72)",
      INK,
    );

    hits.push({ id: inh.id, cx, cy, r: footprint * 0.62 });
  }

  return hits;
}

/** A live visitor wears a small frosted badge showing its brand mark. */
function drawBadge(
  ctx: CanvasRenderingContext2D,
  inh: Inhabitant,
  cx: number,
  cy: number,
  footprint: number,
): void {
  const bx = cx - footprint * 0.6;
  const by = cy;
  const r = footprint * 0.28;
  const mark = resolveMark(inh.id);

  // Soft brand-tinted halo.
  const halo = ctx.createRadialGradient(bx, by, 0, bx, by, r * 2.2);
  halo.addColorStop(0, `${mark.color}55`);
  halo.addColorStop(1, `${mark.color}00`);
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(bx, by, r * 2.2, 0, Math.PI * 2);
  ctx.fill();

  // Frosted disc + hairline ring.
  ctx.fillStyle = "rgba(255, 255, 255, 0.82)";
  ctx.beginPath();
  ctx.arc(bx, by, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = `${mark.color}cc`;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // The real brand mark (resolveMark is total — always a logo, never null).
  mark.draw(ctx, bx, by, r * 0.62);
}

/** A small rounded frosted pill with plain-language text — readable without tapping. */
function drawChip(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  fill: string,
  ink: string,
): void {
  ctx.font = `600 14px system-ui, "Segoe UI", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const padX = 12;
  const wText = ctx.measureText(text).width;
  const w = wText + padX * 2;
  const hh = 24;
  roundRect(ctx, cx - w / 2, cy - hh / 2, w, hh, hh / 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = ink;
  ctx.fillText(text, cx, cy + 0.5);
}

registerTheme({ id: "glass", displayName: "Glass", drawScene: drawSceneGlass }, { default: true });
