import { Bot, TrendingUp, TrendingDown } from "lucide-react";

interface Agent {
  id: string;
  name: string;
  status: "idle" | "working" | "sleeping";
  pnl: string;
  pnlPositive: boolean;
  activity: string;
}

// Mock data for now, will be replaced by WebSocket data
const MOCK_AGENTS: Agent[] = [
  { id: "1", name: "Alpha-1", status: "working", pnl: "+12.5%", pnlPositive: true, activity: "Analyzing market structure..." },
  { id: "2", name: "Beta-2", status: "idle", pnl: "-2.1%", pnlPositive: false, activity: "Waiting for signal." },
  { id: "3", name: "Gamma-3", status: "sleeping", pnl: "+0.0%", pnlPositive: true, activity: "Recharging." },
];

export function AgentsView() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold flex items-center gap-2">
          <Bot className="h-5 w-5 text-purple-400" />
          Active Agents
        </h2>
        <button className="px-4 py-2 bg-purple-600 hover:bg-purple-500 rounded-lg text-sm font-medium transition-colors">
          Deploy New Agent
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {MOCK_AGENTS.map((agent) => (
          <AgentCard key={agent.id} agent={agent} />
        ))}
      </div>
    </div>
  );
}

function AgentCard({ agent }: { agent: Agent }) {
  return (
    <div className="p-5 rounded-xl bg-white/5 border border-white/10 hover:border-purple-500/30 transition-colors group">
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className={`h-10 w-10 rounded-lg flex items-center justify-center ${
            agent.status === "working" ? "bg-green-500/20 text-green-400" :
            agent.status === "idle" ? "bg-yellow-500/20 text-yellow-400" :
            "bg-white/10 text-white/40"
          }`}>
            <Bot className="h-6 w-6" />
          </div>
          <div>
            <div className="font-bold">{agent.name}</div>
            <div className="text-xs text-white/40 uppercase tracking-wider font-medium">{agent.status}</div>
          </div>
        </div>
        <div className={`flex items-center gap-1 text-sm font-bold ${agent.pnlPositive ? "text-green-400" : "text-red-400"}`}>
          {agent.pnlPositive ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
          {agent.pnl}
        </div>
      </div>
      
      <div className="space-y-2">
        <div className="text-xs text-white/40">Current Activity</div>
        <div className="text-sm font-mono bg-black/40 p-2 rounded border border-white/5 truncate">
          {agent.activity}
        </div>
      </div>
      
      <div className="mt-4 pt-4 border-t border-white/5 flex gap-2 overflow-hidden opacity-0 group-hover:opacity-100 transition-opacity">
        <button className="flex-1 py-1.5 bg-white/5 hover:bg-white/10 rounded text-xs font-medium">Logs</button>
        <button className="flex-1 py-1.5 bg-white/5 hover:bg-white/10 rounded text-xs font-medium">Config</button>
      </div>
    </div>
  );
}
