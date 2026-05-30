/// <reference lib="dom" />
import type { BrandMark } from "./types.ts";

function drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number): void {
  ctx.beginPath();
  ctx.moveTo(cx, cy - s);
  ctx.lineTo(cx + s * 0.28, cy - s * 0.28);
  ctx.lineTo(cx + s, cy);
  ctx.lineTo(cx + s * 0.28, cy + s * 0.28);
  ctx.lineTo(cx, cy + s);
  ctx.lineTo(cx - s * 0.28, cy + s * 0.28);
  ctx.lineTo(cx - s, cy);
  ctx.lineTo(cx - s * 0.28, cy - s * 0.28);
  ctx.closePath();
  ctx.fill();
}

/**
 * The fallback mark for any agent with no registered brand (Vesper's own
 * pipelines, or an unknown agent). An evening-star "V": a chevron with a small
 * four-point star above. resolveMark() returns this whenever nothing else matches,
 * so a brand mark ALWAYS exists.
 */
export const VESPER_DEFAULT: BrandMark = {
  id: "vesper",
  label: "Vesper",
  color: "#38f0ff",
  draw(ctx, cx, cy, r) {
    ctx.save();
    ctx.strokeStyle = "#38f0ff";
    ctx.fillStyle = "#38f0ff";
    ctx.lineWidth = Math.max(1.5, r * 0.2);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.55, cy - r * 0.3);
    ctx.lineTo(cx, cy + r * 0.62);
    ctx.lineTo(cx + r * 0.55, cy - r * 0.3);
    ctx.stroke();
    drawStar(ctx, cx, cy - r * 0.62, r * 0.28);
    ctx.restore();
  },
};
