import { useRef, useEffect } from "react";

export interface BotAgent {
  id: string;
  name: string;
  x: number; // position in office (0-1 normalized)
  y: number;
  color: number;
  isRunning: boolean;
  lastThought: string | null;
  strategy: string;
  tickCount: number;
}

interface OfficeViewProps {
  bots: BotAgent[];
}

interface CharState {
  x: number;
  y: number;
  bobOffset: number;
  bobSpeed: number;
  bubbleAge: number;
  thought: string | null;
  isRunning: boolean;
  name: string;
  color: string;
}

function hexColor(n: number): string {
  return `#${n.toString(16).padStart(6, "0")}`;
}

export function OfficeView({ bots }: OfficeViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bgRef = useRef<HTMLImageElement | null>(null);
  const charsRef = useRef<Map<string, CharState>>(new Map());
  const animRef = useRef<number>(0);
  const prevTimeRef = useRef<number>(0);

  // Initialize / update character state from bot data
  useEffect(() => {
    const chars = charsRef.current;
    for (const bot of bots) {
      const existing = chars.get(bot.id);
      if (existing) {
        existing.isRunning = bot.isRunning;
        existing.name = bot.name;
        existing.color = hexColor(bot.color);
        // New thought? Reset bubble timer
        if (bot.lastThought && bot.lastThought !== existing.thought) {
          existing.thought = bot.lastThought;
          existing.bubbleAge = 0;
        }
      } else {
        chars.set(bot.id, {
          x: bot.x,
          y: bot.y,
          bobOffset: Math.random() * Math.PI * 2,
          bobSpeed: 0.002 + Math.random() * 0.001,
          bubbleAge: bot.lastThought ? 0 : 9999,
          thought: bot.lastThought,
          isRunning: bot.isRunning,
          name: bot.name,
          color: hexColor(bot.color),
        });
      }
    }
  }, [bots]);

  // Load background image
  useEffect(() => {
    const img = new Image();
    img.src = "/office.png";
    img.onload = () => {
      bgRef.current = img;
    };
  }, []);

  // Canvas render loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;

    const render = (time: number) => {
      const dt = time - (prevTimeRef.current || time);
      prevTimeRef.current = time;

      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Clear
      ctx.fillStyle = "#111114";
      ctx.fillRect(0, 0, rect.width, rect.height);

      const bg = bgRef.current;
      if (bg) {
        // Draw background scaled to fit
        const scale = Math.min(rect.width / bg.width, rect.height / bg.height);
        const bw = bg.width * scale;
        const bh = bg.height * scale;
        const bx = (rect.width - bw) / 2;
        const by = (rect.height - bh) / 2;

        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(bg, bx, by, bw, bh);

        // Draw characters
        const chars = charsRef.current;
        for (const char of chars.values()) {
          char.bobOffset += dt * char.bobSpeed;
          const bob = Math.sin(char.bobOffset) * 2;

          const cx = bx + char.x * bw;
          const cy = by + char.y * bh + bob;

          // Glow when running
          if (char.isRunning) {
            ctx.save();
            ctx.globalAlpha = 0.15;
            ctx.fillStyle = char.color;
            ctx.beginPath();
            ctx.arc(cx, cy, 18 * scale, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }

          // Shadow
          ctx.save();
          ctx.globalAlpha = 0.3;
          ctx.fillStyle = "#000";
          ctx.beginPath();
          ctx.ellipse(cx, cy + 12 * scale, 8 * scale, 3 * scale, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();

          // Body
          ctx.fillStyle = char.color;
          ctx.fillRect(cx - 5 * scale, cy - 2 * scale, 10 * scale, 12 * scale);

          // Head
          ctx.beginPath();
          ctx.arc(cx, cy - 6 * scale, 5 * scale, 0, Math.PI * 2);
          ctx.fill();

          // Eyes
          ctx.fillStyle = "#fff";
          ctx.fillRect(cx - 3 * scale, cy - 7 * scale, 2 * scale, 2 * scale);
          ctx.fillRect(cx + 1 * scale, cy - 7 * scale, 2 * scale, 2 * scale);

          // Status dot
          ctx.fillStyle = char.isRunning ? "#22c55e" : "#6b7280";
          ctx.beginPath();
          ctx.arc(cx, cy - 14 * scale, 2.5 * scale, 0, Math.PI * 2);
          ctx.fill();

          if (char.isRunning) {
            ctx.strokeStyle = "#22c55e";
            ctx.globalAlpha = 0.5;
            ctx.lineWidth = 0.5;
            ctx.beginPath();
            ctx.arc(cx, cy - 14 * scale, 4 * scale, 0, Math.PI * 2);
            ctx.stroke();
            ctx.globalAlpha = 1;
          }

          // Name tag
          ctx.font = `${Math.max(7, 7 * scale)}px "Courier New", monospace`;
          ctx.textAlign = "center";
          ctx.fillStyle = "rgba(255,255,255,0.7)";
          ctx.fillText(char.name, cx, cy + 22 * scale);

          // Speech bubble
          if (char.thought && char.bubbleAge < 5000) {
            char.bubbleAge += dt;
            const opacity = char.bubbleAge > 3500 ? 1 - (char.bubbleAge - 3500) / 1500 : 1;

            ctx.save();
            ctx.globalAlpha = Math.max(0, opacity);

            const fontSize = Math.max(8, 8 * scale);
            ctx.font = `${fontSize}px "Courier New", monospace`;

            // Word wrap
            const maxW = 160 * scale;
            const words = char.thought.split(" ");
            const lines: string[] = [];
            let currentLine = "";
            for (const word of words) {
              const testLine = currentLine ? currentLine + " " + word : word;
              if (ctx.measureText(testLine).width > maxW) {
                lines.push(currentLine);
                currentLine = word;
              } else {
                currentLine = testLine;
              }
            }
            if (currentLine) lines.push(currentLine);

            const lineHeight = fontSize + 3;
            const padding = 6 * scale;
            const bubbleW = maxW + padding * 2;
            const bubbleH = lines.length * lineHeight + padding * 2;
            const bubbleX = cx - bubbleW / 2;
            const bubbleY = cy - 28 * scale - bubbleH;

            // Bubble background
            ctx.fillStyle = "rgba(26, 26, 46, 0.92)";
            ctx.strokeStyle = char.color;
            ctx.lineWidth = 1.5;
            roundRect(ctx, bubbleX, bubbleY, bubbleW, bubbleH, 4 * scale);
            ctx.fill();
            ctx.stroke();

            // Tail
            ctx.beginPath();
            ctx.moveTo(cx - 5 * scale, bubbleY + bubbleH);
            ctx.lineTo(cx, bubbleY + bubbleH + 6 * scale);
            ctx.lineTo(cx + 5 * scale, bubbleY + bubbleH);
            ctx.closePath();
            ctx.fillStyle = "rgba(26, 26, 46, 0.92)";
            ctx.fill();

            // Text
            ctx.fillStyle = "#fff";
            ctx.textAlign = "left";
            for (let i = 0; i < lines.length; i++) {
              ctx.fillText(lines[i], bubbleX + padding, bubbleY + padding + (i + 1) * lineHeight - 2);
            }

            ctx.restore();
          }
        }

        // Scanline overlay
        ctx.save();
        ctx.globalAlpha = 0.04;
        for (let y = 0; y < rect.height; y += 2) {
          ctx.fillStyle = "#000";
          ctx.fillRect(0, y, rect.width, 1);
        }
        ctx.restore();
      }

      animRef.current = requestAnimationFrame(render);
    };

    animRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animRef.current);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="w-full rounded-2xl border border-white/10 bg-black/40"
      style={{ aspectRatio: "1 / 1", maxHeight: "600px", imageRendering: "pixelated" }}
    />
  );
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
