import { useLayoutEffect, useEffect, useRef, useState } from "react";
import {
  Miniverse,
  type MiniverseConfig,
  type SignalCallback,
  type SceneConfig,
} from "@repo/miniverse-core";
import type { AgentMessage } from "../hooks/useTradingSocket";
import type { BotAgent } from "./OfficeView";
import {
  botsToAgentStatuses,
  createCitizenConfigs,
  createTradingFloorLocations,
} from "./miniverse-bridge";

interface MiniverseViewProps {
  bots: BotAgent[];
  agentMessages?: AgentMessage[];
  speakingAgentId?: string | null;
  onAgentClick?: (agentId: string) => void;
}

function createTradingFloorScene(): SceneConfig {
  const cols = 16;
  const rows = 12;
  const floor: string[][] = [];
  const walkable: boolean[][] = [];

  for (let r = 0; r < rows; r++) {
    floor[r] = [];
    walkable[r] = [];
    for (let c = 0; c < cols; c++) {
      const isEdge = r === 0 || r === rows - 1 || c === 0 || c === cols - 1;
      floor[r][c] = "floor";
      walkable[r][c] = !isEdge;
    }
  }

  // Block desk tiles (agents sit next to them)
  walkable[2][4] = false;
  walkable[2][7] = false;
  walkable[2][10] = false;
  walkable[2][13] = false;

  return {
    name: "trading-floor",
    tileWidth: 32,
    tileHeight: 32,
    layers: [floor],
    walkable,
    locations: {
      desk_1: { x: 4, y: 3, label: "Desk Alpha" },
      desk_2: { x: 7, y: 3, label: "Desk Beta" },
      desk_3: { x: 10, y: 3, label: "Desk Gamma" },
      research_desk: { x: 3, y: 7, label: "Research" },
      conference_table: { x: 8, y: 6, label: "Conference" },
      trading_terminal: { x: 13, y: 3, label: "Terminal" },
      watch_tower: { x: 14, y: 7, label: "Watch Tower" },
      coffee_machine: { x: 3, y: 9, label: "Coffee" },
      break_room: { x: 12, y: 9, label: "Break Room" },
      center: { x: 8, y: 5, label: "Center" },
    },
    tiles: {
      floor: "tiles/office.png",
    },
  };
}

/** Generate a simple 32x32 floor tile procedurally */
function generateFloorTile(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext("2d")!;

  ctx.fillStyle = "#1a1a2e";
  ctx.fillRect(0, 0, 32, 32);
  ctx.strokeStyle = "#16213e";
  ctx.lineWidth = 1;
  ctx.strokeRect(0, 0, 32, 32);

  ctx.fillStyle = "rgba(255,255,255,0.02)";
  for (let i = 0; i < 5; i++) {
    const x = Math.floor(Math.random() * 30) + 1;
    const y = Math.floor(Math.random() * 30) + 1;
    ctx.fillRect(x, y, 1, 1);
  }

  return canvas;
}

export function MiniverseView({
  bots,
  agentMessages,
  speakingAgentId,
  onAgentClick,
}: MiniverseViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const miniverseRef = useRef<Miniverse | null>(null);
  const pushSignalRef = useRef<SignalCallback | null>(null);
  const [hoveredAgent, setHoveredAgent] = useState<{
    id: string;
    name: string;
    x: number;
    y: number;
  } | null>(null);

  useLayoutEffect(() => {
    if (!containerRef.current) return;

    const sceneConfig = createTradingFloorScene();
    const locations = createTradingFloorLocations();
    const citizenConfigs = createCitizenConfigs(bots);

    const config: MiniverseConfig = {
      container: containerRef.current,
      world: "trading-floor",
      scene: "trading-floor",
      sceneConfig,
      signal: {
        type: "callback",
        onRegister: (push) => {
          pushSignalRef.current = push;
        },
      },
      citizens: citizenConfigs,
      scale: 2,
      width: 512,
      height: 384,
      autoSpawn: true,
      defaultSprites: ["nova", "rio", "dexter", "morty"],
    };

    const mv = new Miniverse(config);
    mv.setTypedLocations(locations);

    // Procedural floor tile (fallback when PNG not available)
    const tileCanvas = generateFloorTile();
    const tileImg = new Image();
    tileImg.src = tileCanvas.toDataURL();
    tileImg.onload = () => {
      mv.addTile("floor", tileImg);
    };

    // Meeting glow effect
    mv.addLayer({
      order: 4,
      render: (ctx) => {
        let agentsAtConference = 0;
        for (const citizen of mv.getCitizens()) {
          if (citizen.state === "collaborating") agentsAtConference++;
        }
        if (agentsAtConference >= 2) {
          const confX = 8 * 32 + 16;
          const confY = 6 * 32 + 16;
          ctx.save();
          ctx.globalAlpha = 0.12 + Math.sin(Date.now() * 0.003) * 0.06;
          ctx.fillStyle = "#fbbf24";
          ctx.beginPath();
          ctx.ellipse(confX, confY, 60, 35, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      },
    });

    // Scanline overlay
    mv.addLayer({
      order: 35,
      render: (ctx) => {
        const w = 512;
        const h = 384;
        ctx.save();
        ctx.globalAlpha = 0.03;
        for (let y = 0; y < h; y += 2) {
          ctx.fillStyle = "#000";
          ctx.fillRect(0, y, w, 1);
        }
        ctx.restore();
      },
    });

    // Agent click handler
    mv.on("citizen:click", (data) => {
      const d = data as { agentId: string };
      onAgentClick?.(d.agentId);
    });

    // Hover tooltips
    const canvas = mv.getCanvas();
    const scale = config.scale ?? 2;
    canvas.addEventListener("mousemove", (e) => {
      const citizens = mv.getCitizens();
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const worldX = ((e.clientX - rect.left) * scaleX) / scale;
      const worldY = ((e.clientY - rect.top) * scaleY) / scale;

      for (const citizen of citizens) {
        if (citizen.containsPoint(worldX, worldY)) {
          setHoveredAgent({
            id: citizen.agentId,
            name: citizen.name,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
          canvas.style.cursor = "pointer";
          return;
        }
      }
      setHoveredAgent(null);
      canvas.style.cursor = "default";
    });

    canvas.addEventListener("wheel", (e) => e.preventDefault(), { passive: false });

    mv.start().catch((err) => console.error("Miniverse start failed:", err));
    miniverseRef.current = mv;

    return () => {
      mv.stop();
      miniverseRef.current = null;
      pushSignalRef.current = null;
    };
  }, []);

  // Push state updates to miniverse
  useEffect(() => {
    if (!pushSignalRef.current) return;
    pushSignalRef.current(botsToAgentStatuses(bots));
  }, [bots]);

  // Sync speech bubbles from agent messages
  useEffect(() => {
    const mv = miniverseRef.current;
    if (!mv || !agentMessages?.length) return;

    const seen = new Set<string>();
    for (const msg of agentMessages) {
      if (seen.has(msg.fromAgentId)) continue;
      seen.add(msg.fromAgentId);

      const citizen = mv.getCitizen(msg.fromAgentId);
      if (citizen) {
        const displayText =
          msg.content.length > 60
            ? `${msg.content.slice(0, 57)}...`
            : msg.content;
        citizen.updateState(citizen.state, displayText, citizen.energy);
      }
    }
  }, [agentMessages]);

  const hoveredBot = hoveredAgent
    ? bots.find((b) => b.id === hoveredAgent.id)
    : null;

  return (
    <div className="relative">
      <div
        ref={containerRef}
        className="w-full rounded-2xl border border-white/10 bg-[#0a0a15] overflow-hidden"
        style={{ aspectRatio: "4/3", maxHeight: "600px" }}
      />

      {/* Hover tooltip overlay */}
      {hoveredAgent && hoveredBot && (
        <div
          className="absolute z-50 pointer-events-none"
          style={{
            left: hoveredAgent.x + 12,
            top: hoveredAgent.y - 80,
          }}
        >
          <div className="bg-[#12121a]/95 border border-white/10 rounded-lg px-3 py-2 shadow-xl min-w-[160px]">
            <p className="text-xs font-medium text-white">{hoveredBot.name}</p>
            <p className="text-[10px] text-white/50">{hoveredBot.strategy}</p>
            <div className="flex items-center gap-2 mt-1">
              <span
                className={`text-[10px] ${hoveredBot.isRunning ? "text-green-400" : "text-gray-400"}`}
              >
                {hoveredBot.agentState}
              </span>
              {hoveredBot.isRunning && (
                <span className="text-[10px] text-cyan-400">
                  {hoveredBot.activity}
                </span>
              )}
            </div>
            <p
              className={`text-xs mt-1 ${hoveredBot.pnlToday >= 0 ? "text-green-400" : "text-red-400"}`}
            >
              {hoveredBot.pnlToday >= 0 ? "+" : ""}$
              {hoveredBot.pnlToday.toFixed(2)}
            </p>
            {hoveredBot.lastThought && (
              <p className="text-[10px] text-white/30 mt-1 truncate max-w-[200px]">
                {hoveredBot.lastThought}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
