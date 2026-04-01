import { useRef, useEffect } from "react";
import type { AgentState, AgentActivity, VisualZone } from "@repo/types";
import type { AgentMessage } from "../hooks/useTradingSocket";

export interface BotAgent {
  id: string;
  name: string;
  x: number; // position in office (0-1 normalized)
  y: number;
  color: number;
  isRunning: boolean;
  agentState: AgentState;
  activity: AgentActivity;
  lastThought: string | null;
  strategy: string;
  tickCount: number;
  pnlToday: number;
}

interface OfficeViewProps {
  bots: BotAgent[];
  agentMessages?: AgentMessage[];
}

/** Map AgentActivity to office zone positions (normalized 0-1) */
const ZONE_POSITIONS: Record<VisualZone, { x: number; y: number }> = {
  BREAK_ROOM: { x: 0.15, y: 0.7 },
  RESEARCH_DESK: { x: 0.25, y: 0.35 },
  CONFERENCE_TABLE: { x: 0.5, y: 0.5 },
  TRADING_TERMINAL: { x: 0.75, y: 0.35 },
  WATCH_TOWER: { x: 0.85, y: 0.25 },
  OWN_DESK: { x: 0.5, y: 0.65 },
  COFFEE_MACHINE: { x: 0.2, y: 0.55 },
};

const ACTIVITY_TO_ZONE: Record<AgentActivity, VisualZone> = {
  IDLE: "OWN_DESK",
  ANALYZING: "RESEARCH_DESK",
  DECIDING: "CONFERENCE_TABLE",
  EXECUTING: "TRADING_TERMINAL",
  MONITORING: "WATCH_TOWER",
  COOLDOWN: "COFFEE_MACHINE",
};

interface CharState {
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  bobOffset: number;
  bobSpeed: number;
  bubbleAge: number;
  thought: string | null;
  isRunning: boolean;
  agentState: AgentState;
  activity: AgentActivity;
  name: string;
  color: string;
  pnlToday: number;
  // Conversation message fields
  messageContent: string | null;
  messageType: string | null;
  messageAge: number;
}

/** Border color based on conversation message type */
function messageBorderColor(messageType: string | null): string {
  switch (messageType) {
    case "ANALYSIS":
    case "PROPOSAL":
      return "#3b82f6"; // blue
    case "REVIEW":
    case "AGREEMENT":
      return "#22c55e"; // green
    case "DISAGREEMENT":
      return "#ef4444"; // red
    case "STATUS_UPDATE":
      return "#6b7280"; // gray
    case "THOUGHT":
    default:
      return "#a78bfa"; // purple
  }
}

/** Short label prefix for message types */
function messageTypeLabel(messageType: string | null): string {
  switch (messageType) {
    case "ANALYSIS": return "[ANALYSIS]";
    case "PROPOSAL": return "[PROPOSAL]";
    case "REVIEW": return "[REVIEW]";
    case "AGREEMENT": return "[AGREE]";
    case "DISAGREEMENT": return "[DISAGREE]";
    case "STATUS_UPDATE": return "[STATUS]";
    default: return "";
  }
}

interface SpriteBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const BG_ZOOM = 1.22;

function hexColor(n: number): string {
  return `#${n.toString(16).padStart(6, "0")}`;
}

function stateColor(state: AgentState): string {
  switch (state) {
    case "RUNNING": return "#22c55e";
    case "PAUSED": return "#f59e0b";
    case "ERROR": return "#ef4444";
    case "STOPPED": return "#6b7280";
    case "READY": return "#3b82f6";
    default: return "#6b7280";
  }
}

function activityLabel(activity: AgentActivity): string {
  switch (activity) {
    case "ANALYZING": return "ANALYZING";
    case "DECIDING": return "DECIDING";
    case "EXECUTING": return "EXECUTING";
    case "MONITORING": return "MONITORING";
    case "COOLDOWN": return "COOLDOWN";
    default: return "IDLE";
  }
}

function detectOpaqueBounds(img: HTMLImageElement): SpriteBounds | null {
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.drawImage(img, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, img.width, img.height);

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha > 10) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) return null;
  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

export function OfficeView({ bots, agentMessages }: OfficeViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bgRef = useRef<HTMLImageElement | null>(null);
  const botSpriteRef = useRef<HTMLImageElement | null>(null);
  const botSpriteBoundsRef = useRef<SpriteBounds | null>(null);
  const charsRef = useRef<Map<string, CharState>>(new Map());
  const animRef = useRef<number>(0);
  const prevTimeRef = useRef<number>(0);

  // Initialize / update character state from bot data
  useEffect(() => {
    const chars = charsRef.current;
    for (const bot of bots) {
      const zone = bot.isRunning ? ACTIVITY_TO_ZONE[bot.activity] : "OWN_DESK";
      const zonePos = ZONE_POSITIONS[zone];
      // Offset each bot slightly so they don't overlap at the same zone
      const botIndex = bots.indexOf(bot);
      const offsetX = (botIndex - 1) * 0.06;

      const existing = chars.get(bot.id);
      if (existing) {
        existing.isRunning = bot.isRunning;
        existing.agentState = bot.agentState;
        existing.activity = bot.activity;
        existing.name = bot.name;
        existing.color = hexColor(bot.color);
        existing.pnlToday = bot.pnlToday;
        existing.targetX = zonePos.x + offsetX;
        existing.targetY = zonePos.y;
        // New thought? Reset bubble timer
        if (bot.lastThought && bot.lastThought !== existing.thought) {
          existing.thought = bot.lastThought;
          existing.bubbleAge = 0;
        }
      } else {
        chars.set(bot.id, {
          x: bot.x,
          y: bot.y,
          targetX: zonePos.x + offsetX,
          targetY: zonePos.y,
          bobOffset: Math.random() * Math.PI * 2,
          bobSpeed: 0.002 + Math.random() * 0.001,
          bubbleAge: bot.lastThought ? 0 : 9999,
          thought: bot.lastThought,
          isRunning: bot.isRunning,
          agentState: bot.agentState,
          activity: bot.activity,
          name: bot.name,
          color: hexColor(bot.color),
          pnlToday: bot.pnlToday,
          messageContent: null,
          messageType: null,
          messageAge: 9999,
        });
      }
    }
  }, [bots]);

  // Sync agent conversation messages to character state
  useEffect(() => {
    if (!agentMessages?.length) return;
    const chars = charsRef.current;
    // Only process the most recent message per agent
    const seen = new Set<string>();
    for (const msg of agentMessages) {
      if (seen.has(msg.fromAgentId)) continue;
      seen.add(msg.fromAgentId);
      const char = chars.get(msg.fromAgentId);
      if (char && char.messageContent !== msg.content) {
        char.messageContent = msg.content;
        char.messageType = msg.messageType;
        char.messageAge = 0;
      }
    }
  }, [agentMessages]);

  // Load background image
  useEffect(() => {
    const img = new Image();
    img.src = "/trading-room-bg.png";
    img.onload = () => {
      bgRef.current = img;
    };
  }, []);

  // Load bot sprite image (transparent PNG)
  useEffect(() => {
    const img = new Image();
    img.src = "/bot.png";
    img.onload = () => {
      botSpriteRef.current = img;
      botSpriteBoundsRef.current = detectOpaqueBounds(img);
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
        // Draw background scaled and slightly zoomed for better focus.
        const baseScale = Math.min(rect.width / bg.width, rect.height / bg.height);
        const scale = baseScale * BG_ZOOM;
        const bw = bg.width * scale;
        const bh = bg.height * scale;
        const bx = (rect.width - bw) / 2;
        const by = (rect.height - bh) / 2;

        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(bg, bx, by, bw, bh);

        const botSprite = botSpriteRef.current;
        const botBounds = botSpriteBoundsRef.current;

        // Draw characters
        const chars = charsRef.current;
        for (const char of chars.values()) {
          // Smoothly move toward target position
          const lerpSpeed = 0.003 * dt;
          char.x += (char.targetX - char.x) * Math.min(lerpSpeed, 1);
          char.y += (char.targetY - char.y) * Math.min(lerpSpeed, 1);

          char.bobOffset += dt * char.bobSpeed;
          const bob = Math.sin(char.bobOffset) * 2;

          const cx = bx + char.x * bw;
          const cy = by + char.y * bh + bob;
          const dotColor = stateColor(char.agentState);

          // Glow when running
          if (char.isRunning) {
            ctx.save();
            ctx.globalAlpha = 0.15;
            ctx.fillStyle = char.color;
            ctx.beginPath();
            ctx.arc(cx, cy + 2 * scale, 20 * scale, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }

          const pulse =
            char.isRunning
              ? 1 + Math.sin(char.bobOffset * 2.2) * 0.035
              : 1 + Math.sin(char.bobOffset * 1.1) * 0.015;

          const spriteBounds = botBounds ?? {
            x: 0,
            y: 0,
            width: botSprite?.width ?? 1,
            height: botSprite?.height ?? 1,
          };
          const spriteAspect = spriteBounds.width / Math.max(spriteBounds.height, 1);
          const spriteHeight = Math.max(36, 95 * scale) * pulse;
          const spriteWidth = spriteHeight * spriteAspect;
          const spriteX = cx - spriteWidth / 2;
          const spriteY = cy - spriteHeight + 10 * scale;

          // Shadow
          ctx.save();
          ctx.globalAlpha = 0.35;
          ctx.fillStyle = "#000";
          ctx.beginPath();
          ctx.ellipse(
            cx,
            spriteY + spriteHeight - 2 * scale,
            Math.max(10, spriteWidth * 0.26),
            Math.max(4, spriteHeight * 0.08),
            0,
            0,
            Math.PI * 2,
          );
          ctx.fill();
          ctx.restore();

          if (botSprite) {
            ctx.drawImage(
              botSprite,
              spriteBounds.x,
              spriteBounds.y,
              spriteBounds.width,
              spriteBounds.height,
              spriteX,
              spriteY,
              spriteWidth,
              spriteHeight,
            );
          } else {
            // Fallback glyph while sprite loads.
            ctx.fillStyle = char.color;
            ctx.beginPath();
            ctx.arc(cx, cy, 8 * scale, 0, Math.PI * 2);
            ctx.fill();
          }

          // Status dot (color based on AgentState)
          ctx.fillStyle = dotColor;
          ctx.beginPath();
          ctx.arc(cx, spriteY - 6 * scale, 2.5 * scale, 0, Math.PI * 2);
          ctx.fill();

          if (char.agentState === "RUNNING") {
            ctx.strokeStyle = dotColor;
            ctx.globalAlpha = 0.5;
            ctx.lineWidth = 0.5;
            ctx.beginPath();
            ctx.arc(cx, spriteY - 6 * scale, 4 * scale, 0, Math.PI * 2);
            ctx.stroke();
            ctx.globalAlpha = 1;
          }

          // Name tag + activity
          ctx.font = `${Math.max(7, 7 * scale)}px "Courier New", monospace`;
          ctx.textAlign = "center";
          ctx.fillStyle = "rgba(255,255,255,0.7)";
          ctx.fillText(char.name, cx, spriteY + spriteHeight + 14 * scale);

          // Activity label below name
          if (char.isRunning && char.activity !== "IDLE") {
            ctx.fillStyle = dotColor;
            ctx.font = `${Math.max(6, 6 * scale)}px "Courier New", monospace`;
            ctx.fillText(
              activityLabel(char.activity),
              cx,
              spriteY + spriteHeight + 22 * scale,
            );
          }

          // PnL indicator
          if (char.isRunning) {
            const pnlText = char.pnlToday >= 0
              ? `+$${char.pnlToday.toFixed(2)}`
              : `-$${Math.abs(char.pnlToday).toFixed(2)}`;
            ctx.fillStyle = char.pnlToday >= 0 ? "#22c55e" : "#ef4444";
            ctx.font = `${Math.max(6, 6 * scale)}px "Courier New", monospace`;
            ctx.fillText(pnlText, cx, spriteY + spriteHeight + 30 * scale);
          }

          // Determine which bubble to show: conversation message takes priority
          const hasMessage = char.messageContent && char.messageAge < 8000;
          const hasThought = char.thought && char.bubbleAge < 5000;
          const bubbleText = hasMessage ? char.messageContent : hasThought ? char.thought : null;
          const isConversation = hasMessage;

          if (hasMessage) char.messageAge += dt;
          if (hasThought) char.bubbleAge += dt;

          if (bubbleText) {
            const age = isConversation ? char.messageAge : char.bubbleAge;
            const maxAge = isConversation ? 8000 : 5000;
            const fadeStart = isConversation ? 6000 : 3500;
            const opacity = age > fadeStart ? 1 - (age - fadeStart) / (maxAge - fadeStart) : 1;
            const borderColor = isConversation ? messageBorderColor(char.messageType) : char.color;

            ctx.save();
            ctx.globalAlpha = Math.max(0, opacity);

            const fontSize = Math.max(8, 8 * scale);
            ctx.font = `${fontSize}px "Courier New", monospace`;

            // Prepend message type label for conversation messages
            const displayText = isConversation
              ? `${messageTypeLabel(char.messageType)} ${bubbleText}`
              : bubbleText;

            // Word wrap
            const maxW = 160 * scale;
            const words = displayText.split(" ");
            const lines: string[] = [];
            let currentLine = "";
            for (const word of words) {
              const testLine = currentLine ? `${currentLine} ${word}` : word;
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
            const bubbleY = spriteY - 10 * scale - bubbleH;

            // Bubble background
            ctx.fillStyle = isConversation
              ? "rgba(20, 25, 50, 0.95)"
              : "rgba(26, 26, 46, 0.92)";
            ctx.strokeStyle = borderColor;
            ctx.lineWidth = isConversation ? 2 : 1.5;
            roundRect(ctx, bubbleX, bubbleY, bubbleW, bubbleH, 4 * scale);
            ctx.fill();
            ctx.stroke();

            // Tail
            ctx.beginPath();
            ctx.moveTo(cx - 5 * scale, bubbleY + bubbleH);
            ctx.lineTo(cx, bubbleY + bubbleH + 6 * scale);
            ctx.lineTo(cx + 5 * scale, bubbleY + bubbleH);
            ctx.closePath();
            ctx.fillStyle = isConversation
              ? "rgba(20, 25, 50, 0.95)"
              : "rgba(26, 26, 46, 0.92)";
            ctx.fill();

            // Text
            ctx.fillStyle = "#fff";
            ctx.textAlign = "left";
            for (let i = 0; i < lines.length; i++) {
              // Color the type label differently
              if (isConversation && i === 0) {
                const label = messageTypeLabel(char.messageType);
                const labelWidth = ctx.measureText(label).width;
                ctx.fillStyle = borderColor;
                ctx.fillText(label, bubbleX + padding, bubbleY + padding + lineHeight - 2);
                ctx.fillStyle = "#fff";
                const rest = lines[0].slice(label.length);
                ctx.fillText(rest, bubbleX + padding + labelWidth, bubbleY + padding + lineHeight - 2);
              } else {
                ctx.fillText(lines[i], bubbleX + padding, bubbleY + padding + (i + 1) * lineHeight - 2);
              }
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
