/// <reference lib="dom" />
import { registerMark } from "./registry.ts";
import type { BrandMark } from "./types.ts";

// --- per-brand procedural draws (centered at cx,cy within radius r) ----------

function sunburst(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  c: string,
): void {
  ctx.strokeStyle = c;
  ctx.lineWidth = Math.max(1.5, r * 0.22);
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 - Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r * 0.28, cy + Math.sin(a) * r * 0.28);
    ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    ctx.stroke();
  }
}

function knot(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, c: string): void {
  ctx.strokeStyle = c;
  ctx.lineWidth = Math.max(1.5, r * 0.2);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * r * 0.42, cy + Math.sin(a) * r * 0.42, r * 0.42, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function sparkle(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  c: string,
): void {
  ctx.fillStyle = c;
  const w = r * 0.32;
  const pts: [number, number][] = [
    [0, -r],
    [w, -w],
    [r, 0],
    [w, w],
    [0, r],
    [-w, w],
    [-r, 0],
    [-w, -w],
  ];
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p === undefined) continue;
    if (i === 0) ctx.moveTo(cx + p[0], cy + p[1]);
    else ctx.lineTo(cx + p[0], cy + p[1]);
  }
  ctx.closePath();
  ctx.fill();
}

function terminal(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  c: string,
): void {
  ctx.strokeStyle = c;
  ctx.lineWidth = Math.max(1.5, r * 0.2);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.5, cy - r * 0.4);
  ctx.lineTo(cx - r * 0.05, cy);
  ctx.lineTo(cx - r * 0.5, cy + r * 0.4);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx + r * 0.1, cy + r * 0.45);
  ctx.lineTo(cx + r * 0.6, cy + r * 0.45);
  ctx.stroke();
}

function claw(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, c: string): void {
  ctx.strokeStyle = c;
  ctx.lineWidth = Math.max(1.5, r * 0.22);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(cx, cy - r * 0.1, r * 0.7, Math.PI * 0.15, Math.PI * 0.95);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy + r * 0.35, r * 0.6, -Math.PI * 0.9, -Math.PI * 0.1);
  ctx.stroke();
}

function wingedStaff(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  c: string,
): void {
  ctx.strokeStyle = c;
  ctx.lineWidth = Math.max(1.5, r * 0.18);
  ctx.lineCap = "round";
  // staff
  ctx.beginPath();
  ctx.moveTo(cx, cy - r * 0.7);
  ctx.lineTo(cx, cy + r * 0.7);
  ctx.stroke();
  // two short wings near the top
  for (const dir of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(cx, cy - r * 0.45);
    ctx.quadraticCurveTo(cx + dir * r * 0.7, cy - r * 0.7, cx + dir * r * 0.9, cy - r * 0.3);
    ctx.stroke();
  }
}

function mechClaw(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  c: string,
): void {
  ctx.strokeStyle = c;
  ctx.lineWidth = Math.max(1.5, r * 0.18);
  ctx.lineJoin = "miter";
  // three angular talon segments
  for (let i = -1; i <= 1; i++) {
    const ox = i * r * 0.4;
    ctx.beginPath();
    ctx.moveTo(cx + ox, cy - r * 0.6);
    ctx.lineTo(cx + ox + r * 0.18, cy);
    ctx.lineTo(cx + ox, cy + r * 0.6);
    ctx.stroke();
  }
}

// --- registration ------------------------------------------------------------

const MARKS: readonly BrandMark[] = [
  {
    id: "claude",
    label: "Claude",
    color: "#d97757",
    draw: (c, x, y, r) => sunburst(c, x, y, r, "#d97757"),
  },
  // Codex presents the OpenAI knot; id stays "codex" to match the presence matcher.
  {
    id: "codex",
    label: "Codex",
    color: "#1b1b1b",
    draw: (c, x, y, r) => knot(c, x, y, r, "#1b1b1b"),
  },
  {
    id: "gemini",
    label: "Gemini",
    color: "#7c8cf0",
    draw: (c, x, y, r) => sparkle(c, x, y, r, "#7c8cf0"),
  },
  {
    id: "opencode",
    label: "opencode",
    color: "#f3b03a",
    draw: (c, x, y, r) => terminal(c, x, y, r, "#f3b03a"),
  },
  {
    id: "zeroclaw",
    label: "ZeroClaw",
    color: "#d2691e",
    draw: (c, x, y, r) => claw(c, x, y, r, "#d2691e"),
  },
  {
    id: "hermes",
    label: "Hermes",
    color: "#d4a017",
    draw: (c, x, y, r) => wingedStaff(c, x, y, r, "#d4a017"),
  },
  {
    id: "ironclaw",
    label: "IronClaw",
    color: "#9fb3c8",
    draw: (c, x, y, r) => mechClaw(c, x, y, r, "#9fb3c8"),
  },
];

for (const mark of MARKS) registerMark(mark);
