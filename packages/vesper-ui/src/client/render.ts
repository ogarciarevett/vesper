/// <reference lib="dom" />
import { seededUnit } from "../world/hash.ts";
import type { SceneGraph } from "../world/types.ts";
import { drawSprite, SPRITE_W, type Sprite, spriteFor } from "./sprite.ts";

/** Mood → glow RGB triplet. */
const MOOD_RGB: Record<string, string> = {
  ok: "124, 243, 160",
  no_change: "124, 176, 243",
  error: "255, 154, 139",
  idle: "138, 147, 194",
  working: "124, 243, 208",
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
  /** id → performance.now() timestamp of a recent run, for the "pop" ring. */
  readonly pops: ReadonlyMap<string, number>;
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

function drawBackground(
  ctx: CanvasRenderingContext2D,
  scene: SceneGraph,
  w: number,
  h: number,
  t: number,
): void {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#0b1020");
  g.addColorStop(0.6, "#101733");
  g.addColorStop(1, "#161e3d");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // Seeded stars; density grows with the world's liveliness.
  const stars = Math.floor(40 + scene.liveliness * 140);
  for (let i = 0; i < stars; i++) {
    const sx = seededUnit(`${scene.seed}:star:${i}:x`) * w;
    const sy = seededUnit(`${scene.seed}:star:${i}:y`) * h * 0.8;
    const twinkle = 0.35 + 0.65 * Math.abs(Math.sin(t / 1400 + i * 1.7));
    ctx.globalAlpha = 0.22 * twinkle;
    ctx.fillStyle = i % 5 === 0 ? "#7cf3d0" : "#9fb0ff";
    ctx.fillRect(sx, sy, 2, 2);
  }
  ctx.globalAlpha = 1;

  // Slow-drifting ambient motes — a little life in the air.
  const motes = 10 + Math.floor(scene.liveliness * 10);
  for (let i = 0; i < motes; i++) {
    const dir = i % 2 === 0 ? 1 : -1;
    const baseX = seededUnit(`${scene.seed}:mote:${i}:x`) * w;
    const mx = (((baseX + t * 0.012 * dir) % w) + w) % w;
    const my = seededUnit(`${scene.seed}:mote:${i}:y`) * h + Math.sin(t / 2200 + i) * 10;
    ctx.globalAlpha = 0.12 + 0.1 * Math.abs(Math.sin(t / 1800 + i));
    ctx.fillStyle = "#7cf3d0";
    ctx.fillRect(mx, my, 3, 3);
  }
  ctx.globalAlpha = 1;

  // A soft horizon glow near the bottom — the "floor" of the world.
  const floor = ctx.createLinearGradient(0, h * 0.7, 0, h);
  floor.addColorStop(0, "rgba(124, 243, 208, 0)");
  floor.addColorStop(1, "rgba(124, 243, 208, 0.06)");
  ctx.fillStyle = floor;
  ctx.fillRect(0, h * 0.7, w, h * 0.3);

  // Vignette — settle the corners so the eye lands on the agents.
  const vig = ctx.createRadialGradient(
    w / 2,
    h / 2,
    Math.min(w, h) * 0.35,
    w / 2,
    h / 2,
    Math.max(w, h) * 0.72,
  );
  vig.addColorStop(0, "rgba(0,0,0,0)");
  vig.addColorStop(1, "rgba(0,0,0,0.45)");
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, w, h);
}

/** Draw the whole scene and return click/hover hit regions. */
export function drawScene(
  ctx: CanvasRenderingContext2D,
  scene: SceneGraph,
  w: number,
  h: number,
  t: number,
  opts: RenderOpts,
): HitRegion[] {
  drawBackground(ctx, scene, w, h, t);

  const base = Math.min(w, h);
  const basePixel = Math.max(3, Math.min(11, base / 52));
  const hits: HitRegion[] = [];

  for (const inh of scene.inhabitants) {
    const pixel = Math.max(3, Math.round(basePixel * (0.7 + 0.6 * inh.prominence)));
    const footprint = SPRITE_W * pixel;
    const cx = inh.x * w;
    const baseY = inh.y * h;
    const working = opts.workingIds.has(inh.id);
    // A live external-agent presence (a process running on this machine) gets a
    // gentle, faster "breathing" bob and a teal glow distinct from idle pipelines.
    const live = inh.live;
    const phase = inh.avatarSeed % 1000;
    const bobPeriod = working ? 260 : live ? 520 : 900;
    const bobAmp = working ? 5 : live ? 4 : 3;
    const bob = Math.sin(t / bobPeriod + phase) * bobAmp;
    const cy = baseY + bob;

    const moodKey = working || live ? "working" : inh.mood;
    const rgb = MOOD_RGB[moodKey] ?? MOOD_RGB.idle;
    const intensity = working ? 0.5 : live ? 0.42 : inh.mood === "idle" ? 0.16 : 0.32;

    // Shadow on the floor.
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    ctx.beginPath();
    ctx.ellipse(cx, baseY + footprint * 0.46, footprint * 0.34, footprint * 0.1, 0, 0, Math.PI * 2);
    ctx.fill();

    // Mood glow.
    const glowR = footprint * 0.95;
    const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
    rg.addColorStop(0, `rgba(${rgb}, ${intensity})`);
    rg.addColorStop(1, `rgba(${rgb}, 0)`);
    ctx.fillStyle = rg;
    ctx.beginPath();
    ctx.arc(cx, cy, glowR, 0, Math.PI * 2);
    ctx.fill();

    // Live "heartbeat" ring — only on presences (an agent running right now).
    if (live) {
      const pulse = 0.5 + 0.5 * Math.sin(t / 600 + phase);
      ctx.strokeStyle = `rgba(124, 243, 208, ${0.22 + 0.4 * pulse})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, footprint * (0.52 + 0.12 * pulse), 0, Math.PI * 2);
      ctx.stroke();
    }

    // "Pop" ring after a recent run.
    const pop = opts.pops.get(inh.id);
    if (pop !== undefined) {
      const age = t - pop;
      if (age >= 0 && age < 720) {
        const p = age / 720;
        ctx.strokeStyle = `rgba(${rgb}, ${(1 - p) * 0.7})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, footprint * 0.5 + p * footprint * 0.8, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    drawSprite(ctx, getSprite(inh.avatarSeed), cx, cy, pixel);

    // Nameplate.
    const hovered = opts.hoverId === inh.id;
    ctx.font = `${Math.max(11, Math.round(pixel * 1.5))}px ui-monospace, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = hovered ? "#e8ecff" : "rgba(138,147,194,0.9)";
    ctx.fillText(inh.label, cx, cy + footprint * 0.55);

    hits.push({ id: inh.id, cx, cy, r: footprint * 0.62 });
  }

  return hits;
}
