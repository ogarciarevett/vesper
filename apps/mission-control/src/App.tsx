import { useState, useEffect } from "react";
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
} from "lucide-react";
import { useGameSocket } from "./hooks/useGameSocket";
import { useApiStatus } from "./hooks/useApiStatus";
import { useBotStatus } from "./hooks/useBotStatus";
import { OfficeView, type BotAgent } from "./views/OfficeView";
import { api } from "./lib/api";

// Bot definitions with office positions (normalized 0-1)
const BOT_DEFS = [
  { id: "bot-alpha", name: "Alpha", x: 0.25, y: 0.45, color: 0x22d3ee },
  { id: "bot-beta",  name: "Beta",  x: 0.50, y: 0.55, color: 0xa78bfa },
  { id: "bot-gamma", name: "Gamma", x: 0.72, y: 0.40, color: 0xfbbf24 },
];

function formatTime(ts: number | null) {
  if (!ts) return "--:--:--";
  return new Date(ts).toLocaleTimeString("en-US", { hour12: false });
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
          Cerrar sesión
        </button>
      </div>
    </aside>
  );
}

// --- Bot Card (compact) ---
function BotCard({ botId, name, color }: { botId: string; name: string; color: string }) {
  const { status, loading, start, stop } = useBotStatus(botId);
  const isRunning = status?.isRunning ?? false;

  if (loading) {
    return <div className="bg-white/5 rounded-lg p-3 animate-pulse h-16" />;
  }

  return (
    <div className={`rounded-lg p-3 border transition-all ${
      isRunning ? "bg-green-500/5 border-green-500/15" : "bg-white/3 border-white/5"
    }`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
          <span className="text-xs font-medium text-white/90">{name}</span>
        </div>
        <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${
          isRunning ? "bg-green-500/15 text-green-400" : "bg-white/5 text-white/30"
        }`}>
          {isRunning ? "LIVE" : "OFF"}
        </span>
      </div>
      <div className="flex items-center justify-between">
        <div className="flex gap-3 text-[10px]">
          <span className="text-white/30">Ticks: <span className="text-white/60 font-mono">{status?.tickCount ?? 0}</span></span>
          <span className="text-white/30">Up: <span className="text-white/60 font-mono">{formatUptime(status?.uptime ?? 0)}</span></span>
        </div>
        {isRunning ? (
          <button onClick={stop} className="text-[10px] px-2 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-all cursor-pointer">
            Stop
          </button>
        ) : (
          <button onClick={start} className="text-[10px] px-2 py-0.5 rounded bg-green-500/10 text-green-400 border border-green-500/20 hover:bg-green-500/20 transition-all cursor-pointer">
            Start
          </button>
        )}
      </div>
    </div>
  );
}

// --- Main App ---
function App() {
  const { isConnected, lastMessage } = useGameSocket("main");
  const { online: apiOnline, lastUpdate, refresh: refreshApi } = useApiStatus();
  const [botAgents, setBotAgents] = useState<BotAgent[]>(
    BOT_DEFS.map((d) => ({ ...d, isRunning: false, lastThought: null, strategy: "", tickCount: 0 }))
  );
  const [logs, setLogs] = useState<any[]>([]);

  // Poll all bot statuses and logs
  useEffect(() => {
    const fetchAll = async () => {
      try {
        const statuses = await Promise.allSettled(
          BOT_DEFS.map((b) => api.getBotStatus(b.id))
        );
        const allLogs = await Promise.allSettled(
          BOT_DEFS.map((b) => api.getBotLogs(b.id))
        );

        setBotAgents((prev) =>
          prev.map((agent, i) => {
            const statusResult = statuses[i];
            const logResult = allLogs[i];

            const status = statusResult.status === "fulfilled" ? statusResult.value : null;
            const botLogs = logResult.status === "fulfilled" ? logResult.value.logs : [];

            // Get latest thought from the most recent log
            const latestLog = botLogs?.[0];
            let thought: string | null = null;
            if (latestLog) {
              if (latestLog.error) {
                thought = `❌ ${latestLog.error}`;
              } else if (latestLog.decision) {
                const d = latestLog.decision;
                thought = `${d.action || "ANALYZING"} ${d.asset || ""} (${d.confidence || "??"}% conf)`;
              }
            }

            return {
              ...agent,
              isRunning: status?.isRunning ?? false,
              lastThought: thought,
              strategy: status?.strategy ?? "",
              tickCount: status?.tickCount ?? 0,
            };
          })
        );

        // Merge all logs for the activity feed
        const merged: any[] = [];
        allLogs.forEach((result, i) => {
          if (result.status === "fulfilled") {
            for (const log of result.value.logs || []) {
              merged.push({ ...log, botName: BOT_DEFS[i].name });
            }
          }
        });
        merged.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        setLogs(merged.slice(0, 30));
      } catch {
        /* silent on network error */
      }
    };

    fetchAll();
    const interval = setInterval(fetchAll, 4000);
    return () => clearInterval(interval);
  }, []);

  // WebSocket live updates
  useEffect(() => {
    if (!lastMessage) return;
    try {
      const parsed = JSON.parse(lastMessage);
      if (parsed.type === "bot_update" && parsed.botId) {
        setBotAgents((prev) =>
          prev.map((a) =>
            a.id === parsed.botId
              ? { ...a, lastThought: parsed.thought || a.lastThought, isRunning: parsed.isRunning ?? a.isRunning }
              : a
          )
        );
      }
    } catch { /* not json */ }
  }, [lastMessage]);

  const runningCount = botAgents.filter((b) => b.isRunning).length;
  const idleCount = BOT_DEFS.length - runningCount;

  return (
    <div className="min-h-screen w-full bg-[#111114] text-white font-sans">
      <Sidebar />

      <div className="ml-48 min-h-screen">
        {/* Header */}
        <header className="px-6 pt-6 pb-3">
          <div className="flex items-center justify-between mb-1">
            <h1 className="text-xl font-bold flex items-center gap-2">
              <Flame className="h-5 w-5 text-red-500" />
              Bot Test, Inc.
            </h1>
            <button
              onClick={refreshApi}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-xs text-white/50 hover:text-white hover:bg-white/10 transition-all cursor-pointer"
            >
              <RefreshCw className="h-3 w-3" />
              REFRESH
            </button>
          </div>

          <p className="text-xs text-white/30 mb-3 flex items-center gap-1.5">
            <Clock className="h-3 w-3" />
            Zelda: A Link to the Past (SNES) style office • Last update: {formatTime(lastUpdate)}
          </p>

          {/* Status pills */}
          <div className="flex items-center gap-3 flex-wrap">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-green-500/10 border border-green-500/20 text-green-400 text-xs font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
              ACTIVE ({runningCount})
            </span>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-orange-500/10 border border-orange-500/20 text-orange-400 text-xs font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-orange-400" />
              IDLE ({idleCount})
            </span>
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
              isConnected ? "bg-blue-500/10 border border-blue-500/20 text-blue-400" : "bg-red-500/10 border border-red-500/20 text-red-400"
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? "bg-blue-400" : "bg-red-400"}`} />
              {isConnected ? "HOLOGRAMA IA" : "OFFLINE"}
            </span>
            <span className="ml-auto text-white/30 text-xs flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full ${apiOnline ? "bg-green-400" : "bg-red-400"}`} />
              API {apiOnline ? "OK" : "DOWN"}
            </span>
          </div>
        </header>

        {/* Hover hint */}
        <p className="px-6 text-[11px] text-white/20 mb-3 flex items-center gap-1">
          <Eye className="h-3 w-3" />
          HOVER SOBRE BOTS PARA VER SUS TAREAS • Los pensamientos del agente aparecen como burbujas
        </p>

        {/* Main Content */}
        <div className="px-6 pb-6">
          <div className="grid grid-cols-12 gap-4">
            {/* SNES Office (Pixi.js Interactive Canvas) */}
            <div className="col-span-8">
              <OfficeView bots={botAgents} />
            </div>

            {/* Right Panel */}
            <div className="col-span-4 space-y-3">
              {/* Bot Cards */}
              <h3 className="text-xs font-semibold text-white/40 uppercase tracking-wider flex items-center gap-1.5">
                <Bot className="h-3 w-3" />
                Agents
              </h3>
              {BOT_DEFS.map((bot) => (
                <BotCard
                  key={bot.id}
                  botId={bot.id}
                  name={bot.name}
                  color={`#${bot.color.toString(16).padStart(6, "0")}`}
                />
              ))}

              {/* Activity Log */}
              <h3 className="text-xs font-semibold text-white/40 uppercase tracking-wider mt-4 flex items-center gap-1.5">
                <Activity className="h-3 w-3" />
                Activity Feed
              </h3>
              <div className="rounded-xl bg-black/30 border border-white/5 p-3 max-h-52 overflow-y-auto">
                {logs.length === 0 ? (
                  <div className="text-white/20 text-xs font-mono text-center py-6">
                    No activity yet. Start a bot to see AI decisions here.
                  </div>
                ) : (
                  <div className="space-y-1">
                    {logs.map((log, i) => (
                      <div key={i} className="flex items-start gap-2 px-1 py-1 text-[10px] font-mono hover:bg-white/5 rounded transition-colors">
                        <span className="text-white/20 shrink-0">{formatTime(log.timestamp)}</span>
                        <span className="text-white/30">[{log.botName}]</span>
                        {log.error ? (
                          <span className="text-red-400 truncate">{log.error}</span>
                        ) : (
                          <span className="text-green-400/80 truncate">
                            {log.decision?.action || "HOLD"} {log.decision?.asset || ""}
                          </span>
                        )}
                      </div>
                    ))}
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
