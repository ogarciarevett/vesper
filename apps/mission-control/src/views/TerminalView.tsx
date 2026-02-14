import { Terminal as TerminalIcon } from "lucide-react";
import { useEffect, useRef } from "react";

interface LogEntry {
  id: string;
  timestamp: string;
  level: "info" | "warn" | "error" | "debug";
  source: string;
  message: string;
}

const MOCK_LOGS: LogEntry[] = [
  { id: "1", timestamp: "10:42:01", level: "info", source: "System", message: "Village Engine initialized." },
  { id: "2", timestamp: "10:42:02", level: "info", source: "Network", message: "Connected to Hyperliquid Mainnet." },
  { id: "3", timestamp: "10:42:05", level: "debug", source: "Bot-Alpha", message: "Scanning market structure for BTC-USD." },
  { id: "4", timestamp: "10:42:08", level: "warn", source: "System", message: "High latency detected on node-3." },
  { id: "5", timestamp: "10:42:15", level: "info", source: "Bot-Beta", message: "Order placed: LIMIT 0.042 ETH @ 2800." },
];

export function TerminalView() {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold flex items-center gap-2">
          <TerminalIcon className="h-5 w-5 text-green-400" />
          System Terminal
        </h2>
        <div className="flex gap-2">
           <span className="flex h-2 w-2 rounded-full bg-green-500 animate-pulse"></span>
           <span className="text-xs text-green-400 font-mono">LIVE</span>
        </div>
      </div>

      <div className="flex-1 bg-black/80 rounded-xl border border-white/10 p-4 font-mono text-sm overflow-y-auto custom-scrollbar" ref={scrollRef}>
        {MOCK_LOGS.map((log) => (
          <div key={log.id} className="mb-1 flex gap-3 hover:bg-white/5 p-0.5 rounded px-2">
            <span className="text-white/30 shrink-0">{log.timestamp}</span>
            <span className={`shrink-0 w-20 truncate ${
              log.level === "info" ? "text-blue-400" :
              log.level === "warn" ? "text-yellow-400" :
              log.level === "error" ? "text-red-400" :
              "text-white/40"
            }`}>[{log.source}]</span>
            <span className="text-white/80 break-all">{log.message}</span>
          </div>
        ))}
        <div className="mt-2 text-green-500/50 animate-pulse">_</div>
      </div>
    </div>
  );
}
