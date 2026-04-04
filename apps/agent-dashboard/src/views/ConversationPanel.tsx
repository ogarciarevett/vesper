import { useRef, useEffect } from "react";
import type { AgentMessage } from "../hooks/useTradingSocket";
import type { VoiceQueueState } from "../hooks/useVoiceQueue";

interface ConversationPanelProps {
  messages: AgentMessage[];
  voiceState: VoiceQueueState;
  onToggleVoice: () => void;
  onVolumeChange: (volume: number) => void;
}

const MESSAGE_TYPE_COLORS: Record<string, string> = {
  THOUGHT: "text-purple-400",
  ANALYSIS: "text-blue-400",
  PROPOSAL: "text-blue-300",
  REVIEW: "text-yellow-400",
  AGREEMENT: "text-green-400",
  DISAGREEMENT: "text-red-400",
  STATUS_UPDATE: "text-gray-400",
};

const MESSAGE_TYPE_BADGES: Record<string, string> = {
  THOUGHT: "bg-purple-500/20 text-purple-300",
  ANALYSIS: "bg-blue-500/20 text-blue-300",
  PROPOSAL: "bg-blue-500/20 text-blue-200",
  REVIEW: "bg-yellow-500/20 text-yellow-300",
  AGREEMENT: "bg-green-500/20 text-green-300",
  DISAGREEMENT: "bg-red-500/20 text-red-300",
  STATUS_UPDATE: "bg-gray-500/20 text-gray-300",
};

function formatTime(ts: string): string {
  const date = new Date(ts);
  return date.toLocaleTimeString("en-US", { hour12: false });
}

function agentDisplayName(agentId: string): string {
  const parts = agentId.split("-");
  const last = parts[parts.length - 1];
  if (last && ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"].includes(last)) {
    return last.charAt(0).toUpperCase() + last.slice(1);
  }
  return agentId.length > 12 ? `${agentId.slice(0, 12)}...` : agentId;
}

export function ConversationPanel({
  messages,
  voiceState,
  onToggleVoice,
  onVolumeChange,
}: ConversationPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [messages.length]);

  return (
    <div className="flex flex-col h-full bg-[#0d0d12] rounded-xl border border-white/10 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-[#12121a]">
        <h3 className="text-sm font-medium text-white/80">Agent Conversations</h3>
        <div className="flex items-center gap-2">
          {/* Voice controls */}
          <button
            type="button"
            onClick={onToggleVoice}
            className={`px-2 py-1 text-xs rounded transition-colors ${
              voiceState.enabled
                ? "bg-green-500/20 text-green-300 hover:bg-green-500/30"
                : "bg-white/5 text-white/40 hover:bg-white/10"
            }`}
          >
            {voiceState.enabled ? "🔊" : "🔇"}
          </button>
          {voiceState.enabled && (
            <input
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={voiceState.volume}
              onChange={(e) => onVolumeChange(Number.parseFloat(e.target.value))}
              className="w-16 h-1 accent-green-500"
            />
          )}
          {voiceState.isPlaying && voiceState.speakingAgentId && (
            <span className="text-xs text-green-400 animate-pulse">
              {agentDisplayName(voiceState.speakingAgentId)} speaking
            </span>
          )}
        </div>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-3 py-2 space-y-2"
        style={{ maxHeight: "400px" }}
      >
        {messages.length === 0 && (
          <p className="text-center text-white/20 text-xs py-8">
            No agent conversations yet
          </p>
        )}
        {messages.map((msg) => (
          <div
            key={msg.messageId}
            className={`p-2 rounded-lg bg-white/[0.03] border border-white/5 hover:border-white/10 transition-colors ${
              voiceState.speakingAgentId === msg.fromAgentId && voiceState.isPlaying
                ? "border-green-500/30 bg-green-500/5"
                : ""
            }`}
          >
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-medium text-white/70">
                {agentDisplayName(msg.fromAgentId)}
              </span>
              {msg.toAgentId && (
                <>
                  <span className="text-white/20 text-xs">→</span>
                  <span className="text-xs text-white/50">
                    {agentDisplayName(msg.toAgentId)}
                  </span>
                </>
              )}
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                  MESSAGE_TYPE_BADGES[msg.messageType] ?? "bg-gray-500/20 text-gray-400"
                }`}
              >
                {msg.messageType}
              </span>
              <span className="text-[10px] text-white/20 ml-auto">
                {formatTime(msg.timestamp)}
              </span>
            </div>
            <p
              className={`text-xs leading-relaxed ${
                MESSAGE_TYPE_COLORS[msg.messageType] ?? "text-white/60"
              }`}
            >
              {msg.content}
            </p>
            {msg.replyToMessageId && (
              <span className="text-[10px] text-white/15 mt-1 block">
                ↩ reply to {msg.replyToMessageId.slice(0, 8)}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Footer status */}
      <div className="px-4 py-2 border-t border-white/5 text-[10px] text-white/20">
        {messages.length} messages
        {voiceState.queueSize > 0 && ` · ${voiceState.queueSize} in voice queue`}
      </div>
    </div>
  );
}
