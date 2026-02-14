import { useCallback, useEffect, useMemo, useState } from "react";
import {
  RefreshCw,
  Flame,
  Activity,
  Building2,
  Settings,
  LogOut,
  Clock,
  Eye,
  Bot,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  DollarSign,
  Shield,
  Pause,
} from "lucide-react";
import type { AgentActivity, AgentRealtimeState, AgentState } from "@repo/types";
import { useTradingSocket, type TradeEvent } from "./hooks/useTradingSocket";
import { useApiStatus } from "./hooks/useApiStatus";
import { useBotStatus } from "./hooks/useBotStatus";
import { OfficeView, type BotAgent } from "./views/OfficeView";
import { api } from "./lib/api";

const ROOM_ID = import.meta.env.VITE_ROOM_ID || "main";
const BOT_COLORS = [0x22d3ee, 0xa78bfa, 0xfbbf24, 0x34d399, 0xf97316, 0xfb7185];
const BOT_POSITIONS = [
  { x: 0.25, y: 0.45 },
  { x: 0.5, y: 0.55 },
  { x: 0.72, y: 0.4 },
  { x: 0.32, y: 0.66 },
  { x: 0.64, y: 0.3 },
  { x: 0.84, y: 0.62 },
];

interface RoomBot {
  id: string;
  publicId: string;
  name: string;
  pair: string;
  color: number;
  x: number;
  y: number;
}

interface FallbackState {
  isRunning: boolean;
  tickCount: number;
  thought: string | null;
  strategy: string;
  agentState: AgentState;
  activity: AgentActivity;
  pnlToday: number;
}

interface FeedEntry {
  timestamp: number;
  botName: string;
  error?: string;
  decision?: {
    action?: string;
    pair?: string;
    asset?: string;
    confidence?: number;
  };
}

function formatTime(ts: number | string | null) {
  if (!ts) return "--:--:--";
  const date = typeof ts === "string" ? new Date(ts) : new Date(ts);
  return date.toLocaleTimeString("en-US", { hour12: false });
}

function formatUptime(ms: number) {
  if (!ms) return "0s";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function formatPnl(value: number): string {
  if (value >= 0) return `+$${value.toFixed(2)}`;
  return `-$${Math.abs(value).toFixed(2)}`;
}

function toDisplayName(raw: string): string {
  if (!raw) return "Bot";
  return raw
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getBotVisual(index: number): { color: number; x: number; y: number } {
  const base = BOT_POSITIONS[index % BOT_POSITIONS.length]!;
  return {
    color: BOT_COLORS[index % BOT_COLORS.length]!,
    x: base.x,
    y: base.y,
  };
}

function toPublicBotId(agentId: string): string {
  const parts = agentId.split("-");
  const suffix = parts[parts.length - 1]?.toLowerCase();
  if (
    parts.length > 1 &&
    suffix &&
    ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"].includes(
      suffix,
    )
  ) {
    return suffix;
  }
  return agentId;
}

// --- Sidebar ---
function Sidebar() {
  return (
    <aside className="w-48 bg-[#1a1a1f] border-r border-white/5 flex flex-col h-screen fixed left-0 top-0 z-40">
      <div className="px-4 py-5 border-b border-white/5">
        <div className="flex items-center gap-2">
          <Flame className="h-5 w-5 text-red-500" />
          <span className="font-semibold text-sm text-white">Mission Control</span>
        </div>
      </div>

      <nav className="flex-1 py-3 px-2 space-y-0.5 overflow-y-auto">
        <button className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] bg-red-600 text-white font-medium cursor-default">
          <Building2 className="h-4 w-4 shrink-0" />
          Office
          <Flame className="h-3 w-3 ml-auto" />
        </button>
      </nav>

      <div className="border-t border-white/5 p-3 space-y-1">
        <button className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] text-white/40 hover:text-white/70 hover:bg-white/5 transition-all">
          <Settings className="h-4 w-4" />
          Settings
        </button>
        <div className="px-3 py-1.5 text-[10px] text-white/20 font-mono">OpenClaw Agent</div>
        <button className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] text-white/30 hover:text-red-400 hover:bg-white/5 transition-all">
          <LogOut className="h-4 w-4" />
          Cerrar sesion
        </button>
      </div>
    </aside>
  );
}

// --- Bot Card (enhanced with trading data) ---
function BotCard({
  botKey,
  name,
  pair,
  roomId,
  color,
  wsState,
}: {
  botKey: string;
  name: string;
  pair: string;
  roomId: string;
  color: string;
  wsState: AgentRealtimeState | undefined;
}) {
  const { status, loading, start, stop, pause } = useBotStatus(botKey, {
    roomId,
    pair,
  });

  // Prefer WebSocket state, fallback to polling
  const agentState: AgentState =
    wsState?.state ?? (status?.agentState as AgentState) ?? "CREATED";
  const activity: AgentActivity =
    wsState?.activity ?? (status?.activity as AgentActivity) ?? "IDLE";
  const isRunning = agentState === "RUNNING";
  const pnlToday = wsState?.pnlToday ?? status?.pnlToday ?? 0;
  const tradeCount = wsState?.tradeCountToday ?? status?.tradeCountToday ?? 0;
  const thought = wsState?.currentThought ?? status?.currentThought ?? null;

  if (loading && !wsState) {
    return <div className="bg-white/5 rounded-lg p-3 animate-pulse h-20" />;
  }

  const stateLabel = agentState === "RUNNING" ? activity : agentState;
  const stateClass =
    agentState === "RUNNING"
      ? "bg-green-500/15 text-green-400"
      : agentState === "PAUSED"
        ? "bg-yellow-500/15 text-yellow-400"
        : agentState === "ERROR"
          ? "bg-red-500/15 text-red-400"
          : "bg-white/5 text-white/30";

  return (
    <div
      className={`rounded-lg p-3 border transition-all ${
        isRunning ? "bg-green-500/5 border-green-500/15" : "bg-white/3 border-white/5"
      }`}
    >
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
          <span className="text-xs font-medium text-white/90">{name}</span>
        </div>
        <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${stateClass}`}>
          {stateLabel}
        </span>
      </div>

      <div className="flex gap-3 text-[10px] mb-1.5">
        <span className="text-white/30">
          Pair: <span className="text-cyan-400 font-mono">{pair}</span>
        </span>
        <span className="text-white/30">
          PnL:{" "}
          <span className={`font-mono ${pnlToday >= 0 ? "text-green-400" : "text-red-400"}`}>
            {formatPnl(pnlToday)}
          </span>
        </span>
        <span className="text-white/30">
          Trades: <span className="text-white/60 font-mono">{tradeCount}</span>
        </span>
        <span className="text-white/30">
          Ticks: <span className="text-white/60 font-mono">{status?.tickCount ?? 0}</span>
        </span>
      </div>

      {thought && (
        <div className="text-[9px] text-white/40 font-mono truncate mb-1.5" title={thought}>
          {thought}
        </div>
      )}

      <div className="flex items-center justify-between">
        <span className="text-[10px] text-white/30">
          Up: <span className="text-white/60 font-mono">{formatUptime(status?.uptime ?? 0)}</span>
        </span>
        <div className="flex gap-1">
          {isRunning ? (
            <>
              <button
                onClick={pause}
                className="text-[10px] px-2 py-0.5 rounded bg-yellow-500/10 text-yellow-400 border border-yellow-500/20 hover:bg-yellow-500/20 transition-all cursor-pointer"
              >
                <Pause className="h-3 w-3 inline" />
              </button>
              <button
                onClick={stop}
                className="text-[10px] px-2 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-all cursor-pointer"
              >
                Stop
              </button>
            </>
          ) : (
            <button
              onClick={start}
              className="text-[10px] px-2 py-0.5 rounded bg-green-500/10 text-green-400 border border-green-500/20 hover:bg-green-500/20 transition-all cursor-pointer"
            >
              Start
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Activity Feed Item ---
function ActivityFeedItem({ event, botName }: { event: TradeEvent; botName: string }) {
  const eventColors: Record<string, string> = {
    ORDER_PLACED: "text-blue-400",
    ORDER_FILLED: "text-green-400",
    ORDER_CANCELLED: "text-yellow-400",
    POSITION_OPENED: "text-cyan-400",
    POSITION_CLOSED: "text-purple-400",
    ORDER_FAILED: "text-red-400",
    RISK_REJECTED: "text-orange-400",
    FORCE_STOP: "text-red-300",
  };

  return (
    <div className="flex items-start gap-2 px-1 py-1 text-[10px] font-mono hover:bg-white/5 rounded transition-colors">
      <span className="text-white/20 shrink-0">{formatTime(event.timestamp)}</span>
      <span className="text-white/30">[{botName}]</span>
      <span className={eventColors[event.event] ?? "text-white/60"}>{event.event}</span>
    </div>
  );
}

// --- Main App ---
function App() {
  const {
    isConnected,
    connectionState,
    reconnectAttempts,
    botStates,
    roomState,
    tradeEvents,
    lastError,
  } = useTradingSocket(ROOM_ID);
  const { online: apiOnline, lastUpdate, refresh: refreshApi } = useApiStatus();

  const [roomBots, setRoomBots] = useState<RoomBot[]>([]);
  const [roomBindingError, setRoomBindingError] = useState<string | null>(null);
  const [logs, setLogs] = useState<FeedEntry[]>([]);
  const [fallbackStates, setFallbackStates] = useState<Map<string, FallbackState>>(
    new Map(),
  );

  const loadRoomBots = useCallback(async () => {
    try {
      const info = await api.getRoomInfo(ROOM_ID);
      if (info.roomId && info.roomId !== ROOM_ID) {
        setRoomBindingError(
          `Room binding mismatch: expected "${ROOM_ID}" but server reports "${info.roomId}"`,
        );
      } else {
        setRoomBindingError(null);
      }

        const next: RoomBot[] = (info.bots ?? []).map((bot, index) => {
          const visual = getBotVisual(index);
          return {
            id: bot.agentId,
            publicId: toPublicBotId(bot.agentId),
            name: bot.name || toDisplayName(bot.agentId),
            pair: bot.pair || "ETH",
            color: visual.color,
            x: visual.x,
          y: visual.y,
        };
      });

      setRoomBots(next);
    } catch (error) {
      setRoomBindingError(`Failed to load room "${ROOM_ID}": ${String(error)}`);
      setRoomBots([]);
    }
  }, []);

  useEffect(() => {
    void loadRoomBots();
  }, [loadRoomBots]);

  useEffect(() => {
    if (roomState && roomState.roomId !== ROOM_ID) {
      setRoomBindingError(
        `WS room mismatch: expected "${ROOM_ID}" but received "${roomState.roomId}"`,
      );
    }
  }, [roomState]);

  const refreshAll = useCallback(async () => {
    await Promise.allSettled([refreshApi(), loadRoomBots()]);
  }, [refreshApi, loadRoomBots]);

  useEffect(() => {
    const fetchAll = async () => {
      if (roomBots.length === 0) {
        setFallbackStates(new Map());
        setLogs([]);
        return;
      }

      try {
        const statuses = await Promise.allSettled(
          roomBots.map((b) => api.getBotStatus(b.publicId, ROOM_ID)),
        );
        const allLogs = await Promise.allSettled(
          roomBots.map((b) => api.getBotLogs(b.publicId, ROOM_ID)),
        );

        const newFallback = new Map<string, FallbackState>();

        for (let i = 0; i < roomBots.length; i++) {
          const statusResult = statuses[i];
          const logResult = allLogs[i];
          const bot = roomBots[i]!;

          const status = statusResult.status === "fulfilled" ? statusResult.value : null;
          const botLogs = logResult.status === "fulfilled" ? logResult.value.logs : [];

          let thought: string | null = null;
          const latestLog = botLogs?.[0];
          if (latestLog) {
            if (latestLog.error) {
              thought = latestLog.error;
            } else if (latestLog.decision) {
              const d = latestLog.decision;
              const decisionPair = d.pair || d.asset || bot.pair;
              thought = `${d.action || "ANALYZING"} ${decisionPair} (${d.confidence || "??"}% conf)`;
            }
          }

          newFallback.set(bot.id, {
            isRunning: status?.isRunning ?? false,
            tickCount: status?.tickCount ?? 0,
            thought,
            strategy: status?.strategy ?? "",
            agentState: (status?.agentState as AgentState) ?? "CREATED",
            activity: (status?.activity as AgentActivity) ?? "IDLE",
            pnlToday: status?.pnlToday ?? 0,
          });
        }

        setFallbackStates(newFallback);

        const merged: FeedEntry[] = [];
        allLogs.forEach((result, i) => {
          const bot = roomBots[i];
          if (!bot || result.status !== "fulfilled") return;
          for (const log of result.value.logs || []) {
            merged.push({
              timestamp: log.timestamp,
              botName: bot.name,
              error: log.error,
              decision: log.decision,
            });
          }
        });
        merged.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        setLogs(merged.slice(0, 30));
      } catch {
        // keep previous fallback state on network failures
      }
    };

    void fetchAll();
    const interval = setInterval(fetchAll, isConnected ? 30_000 : 15_000);
    return () => clearInterval(interval);
  }, [isConnected, roomBots]);

  const botAgents: BotAgent[] = useMemo(
    () =>
      roomBots.map((def) => {
        const ws = botStates.get(def.id);
        const fb = fallbackStates.get(def.id);

        return {
          ...def,
          isRunning: ws?.state === "RUNNING" || fb?.isRunning || false,
          agentState: ws?.state ?? fb?.agentState ?? "CREATED",
          activity: ws?.activity ?? fb?.activity ?? "IDLE",
          lastThought: ws?.currentThought ?? fb?.thought ?? null,
          strategy: fb?.strategy ?? "",
          tickCount: fb?.tickCount ?? 0,
          pnlToday: ws?.pnlToday ?? fb?.pnlToday ?? 0,
        };
      }),
    [roomBots, botStates, fallbackStates],
  );

  const runningCount = botAgents.filter((b) => b.isRunning).length;
  const idleCount = Math.max(roomBots.length - runningCount, 0);
  const botNameMap = useMemo(() => new Map(roomBots.map((b) => [b.id, b.name])), [roomBots]);

  const wsStatusClass =
    connectionState === "connected"
      ? "bg-blue-500/10 border border-blue-500/20 text-blue-400"
      : connectionState === "reconnecting"
        ? "bg-yellow-500/10 border border-yellow-500/20 text-yellow-400"
        : connectionState === "connecting"
          ? "bg-white/10 border border-white/20 text-white/70"
          : "bg-red-500/10 border border-red-500/20 text-red-400";

  const wsStatusDot =
    connectionState === "connected"
      ? "bg-blue-400"
      : connectionState === "reconnecting"
        ? "bg-yellow-400"
        : connectionState === "connecting"
          ? "bg-white/70"
          : "bg-red-400";

  const wsStatusLabel =
    connectionState === "connected"
      ? "TradingRoom WS"
      : connectionState === "reconnecting"
        ? `WS RECONNECT (${reconnectAttempts})`
        : connectionState === "connecting"
          ? "WS CONNECTING"
          : "WS ERROR";

  return (
    <div className="min-h-screen w-full bg-[#111114] text-white font-sans">
      <Sidebar />

      <div className="ml-48 min-h-screen">
        <header className="px-6 pt-6 pb-3">
          <div className="flex items-center justify-between mb-1">
            <h1 className="text-xl font-bold flex items-center gap-2">
              <Flame className="h-5 w-5 text-red-500" />
              TradingRoom ({ROOM_ID})
            </h1>
            <button
              onClick={() => void refreshAll()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-xs text-white/50 hover:text-white hover:bg-white/10 transition-all cursor-pointer"
            >
              <RefreshCw className="h-3 w-3" />
              REFRESH
            </button>
          </div>

          <p className="text-xs text-white/30 mb-3 flex items-center gap-1.5">
            <Clock className="h-3 w-3" />
            SNES-style office view -- Last update: {formatTime(lastUpdate)}
          </p>

          <div className="flex items-center gap-3 flex-wrap">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-green-500/10 border border-green-500/20 text-green-400 text-xs font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
              ACTIVE ({runningCount})
            </span>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-orange-500/10 border border-orange-500/20 text-orange-400 text-xs font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-orange-400" />
              IDLE ({idleCount})
            </span>
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${wsStatusClass}`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${wsStatusDot}`} />
              {wsStatusLabel}
            </span>

            {roomState && (
              <>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/5 border border-white/10 text-xs font-medium text-white/60">
                  <DollarSign className="h-3 w-3" />
                  PnL:{" "}
                  <span className={roomState.totalPnlToday >= 0 ? "text-green-400" : "text-red-400"}>
                    {formatPnl(roomState.totalPnlToday)}
                  </span>
                </span>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/5 border border-white/10 text-xs font-medium text-white/60">
                  <Shield className="h-3 w-3" />
                  Risk:{" "}
                  <span
                    className={
                      roomState.riskStatus === "NORMAL"
                        ? "text-green-400"
                        : roomState.riskStatus === "WARNING"
                          ? "text-yellow-400"
                          : "text-red-400"
                    }
                  >
                    {roomState.riskStatus}
                  </span>
                </span>
              </>
            )}

            <span className="ml-auto text-white/30 text-xs flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full ${apiOnline ? "bg-green-400" : "bg-red-400"}`} />
              API {apiOnline ? "OK" : "DOWN"}
            </span>
          </div>
        </header>

        <p className="px-6 text-[11px] text-white/20 mb-2 flex items-center gap-1">
          <Eye className="h-3 w-3" />
          Bots move to zones based on activity -- Thoughts appear as speech bubbles
        </p>
        {roomBindingError && (
          <p className="px-6 text-[11px] text-red-400/90 mb-3 flex items-center gap-1">
            <AlertTriangle className="h-3 w-3" />
            {roomBindingError}
          </p>
        )}
        {!roomBindingError && lastError && (
          <p className="px-6 text-[11px] text-yellow-400/80 mb-3 flex items-center gap-1">
            <AlertTriangle className="h-3 w-3" />
            {lastError}
          </p>
        )}

        <div className="px-6 pb-6">
          <div className="grid grid-cols-12 gap-4">
            <div className="col-span-8">
              <OfficeView bots={botAgents} />
            </div>

            <div className="col-span-4 space-y-3">
              <h3 className="text-xs font-semibold text-white/40 uppercase tracking-wider flex items-center gap-1.5">
                <Bot className="h-3 w-3" />
                Agents
              </h3>
              {roomBots.length === 0 ? (
                <div className="rounded-xl bg-black/30 border border-white/5 p-4 text-xs text-white/40">
                  No bots registered in room <span className="font-mono text-white/70">{ROOM_ID}</span>.
                </div>
              ) : (
                roomBots.map((bot) => (
                  <BotCard
                    key={bot.id}
                    botKey={bot.publicId}
                    name={bot.name}
                    pair={bot.pair}
                    roomId={ROOM_ID}
                    color={`#${bot.color.toString(16).padStart(6, "0")}`}
                    wsState={botStates.get(bot.id)}
                  />
                ))
              )}

              <h3 className="text-xs font-semibold text-white/40 uppercase tracking-wider mt-4 flex items-center gap-1.5">
                <Activity className="h-3 w-3" />
                Activity Feed
              </h3>
              <div className="rounded-xl bg-black/30 border border-white/5 p-3 max-h-52 overflow-y-auto">
                {tradeEvents.length > 0 ? (
                  <div className="space-y-1">
                    {tradeEvents.map((event, i) => (
                      <ActivityFeedItem
                        key={`${event.timestamp}-${i}`}
                        event={event}
                        botName={botNameMap.get(event.agentId) ?? event.agentId}
                      />
                    ))}
                  </div>
                ) : logs.length > 0 ? (
                  <div className="space-y-1">
                    {logs.map((log, i) => (
                      <div
                        key={i}
                        className="flex items-start gap-2 px-1 py-1 text-[10px] font-mono hover:bg-white/5 rounded transition-colors"
                      >
                        <span className="text-white/20 shrink-0">{formatTime(log.timestamp)}</span>
                        <span className="text-white/30">[{log.botName}]</span>
                        {log.error ? (
                          <span className="text-red-400 truncate flex items-center gap-1">
                            <AlertTriangle className="h-3 w-3 shrink-0" />
                            {log.error}
                          </span>
                        ) : (
                          <span className="text-green-400/80 truncate flex items-center gap-1">
                            {log.decision?.action === "HOLD" ? (
                              <TrendingDown className="h-3 w-3 shrink-0 text-white/30" />
                            ) : (
                              <TrendingUp className="h-3 w-3 shrink-0" />
                            )}
                            {log.decision?.action || "HOLD"} {log.decision?.pair || log.decision?.asset || ""}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-white/20 text-xs font-mono text-center py-6">
                    No activity yet. Start a bot to see AI decisions here.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
