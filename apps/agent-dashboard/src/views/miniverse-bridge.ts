import type { AgentActivity, AgentState } from "@repo/types";
import type { AgentStatus, CitizenConfig, TypedLocation, AnchorType } from "@repo/miniverse-core";
import type { BotAgent } from "./OfficeView";
import type { AgentMessage } from "../hooks/useTradingSocket";

/** Map our AgentActivity to miniverse AgentState */
export function mapActivityToMiniverseState(
  bot: BotAgent,
): AgentStatus["state"] {
  if (!bot.isRunning) {
    switch (bot.agentState) {
      case "PAUSED": return "sleeping";
      case "STOPPED": return "offline";
      case "ERROR": return "error";
      case "READY": return "waiting";
      default: return "idle";
    }
  }

  switch (bot.activity) {
    case "ANALYZING": return "thinking";
    case "DECIDING": return "collaborating";
    case "EXECUTING": return "working";
    case "MONITORING": return "working";
    case "COOLDOWN": return "idle";
    default: return "idle";
  }
}

/** Map bot activity to target anchor name */
export function getTargetAnchor(bot: BotAgent, botIndex: number): string {
  if (!bot.isRunning) return `desk_${(botIndex % 3) + 1}`;

  switch (bot.activity) {
    case "ANALYZING": return "research_desk";
    case "DECIDING": return "conference_table";
    case "EXECUTING": return "trading_terminal";
    case "MONITORING": return "watch_tower";
    case "COOLDOWN": return "coffee_machine";
    default: return `desk_${(botIndex % 3) + 1}`;
  }
}

/** Map strategy type to sprite name */
export function getSpriteForStrategy(strategy: string): string {
  switch (strategy) {
    case "MOMENTUM_SCALPER":
    case "BREAKOUT_HUNTER":
      return "nova";
    case "MEAN_REVERSION":
    case "SENTIMENT_ANALYZER":
    case "POLYMARKET_SCRAPER":
    case "POLYMARKET_TWITTER":
      return "rio";
    case "POLYMARKET_EXECUTOR":
    case "GRID_TRADER":
      return "dexter";
    case "POLYMARKET_REVIEWER":
      return "morty";
    default:
      return "nova";
  }
}

/** Convert BotAgent array to miniverse AgentStatus array for the signal system */
export function botsToAgentStatuses(bots: BotAgent[]): AgentStatus[] {
  return bots.map((bot) => ({
    id: bot.id,
    name: bot.name,
    state: mapActivityToMiniverseState(bot),
    task: bot.lastThought,
    energy: bot.isRunning ? 0.8 : 0.2,
    metadata: {
      strategy: bot.strategy,
      pnlToday: bot.pnlToday,
      activity: bot.activity,
      agentState: bot.agentState,
    },
  }));
}

/** Create citizen configs for initial bot list */
export function createCitizenConfigs(bots: BotAgent[]): CitizenConfig[] {
  return bots.map((bot, i) => ({
    agentId: bot.id,
    name: bot.name,
    sprite: getSpriteForStrategy(bot.strategy),
    position: `desk_${(i % 3) + 1}`,
  }));
}

/** Build typed locations for our trading floor zones */
export function createTradingFloorLocations(): TypedLocation[] {
  return [
    // Work anchors — agent desks
    { name: "desk_1", x: 4, y: 3, type: "work" as AnchorType },
    { name: "desk_2", x: 7, y: 3, type: "work" as AnchorType },
    { name: "desk_3", x: 10, y: 3, type: "work" as AnchorType },
    // Research station
    { name: "research_desk", x: 3, y: 7, type: "work" as AnchorType },
    // Social — conference table
    { name: "conference_table", x: 8, y: 6, type: "social" as AnchorType },
    // Work — trading terminal
    { name: "trading_terminal", x: 13, y: 3, type: "work" as AnchorType },
    // Utility — watch tower / monitoring
    { name: "watch_tower", x: 14, y: 7, type: "utility" as AnchorType },
    // Utility — coffee machine
    { name: "coffee_machine", x: 3, y: 9, type: "utility" as AnchorType },
    // Rest — break room
    { name: "break_room", x: 12, y: 9, type: "rest" as AnchorType },
    // Wander points for idle roaming
    { name: "hallway_1", x: 6, y: 5, type: "wander" as AnchorType },
    { name: "hallway_2", x: 10, y: 5, type: "wander" as AnchorType },
    { name: "hallway_3", x: 8, y: 9, type: "wander" as AnchorType },
  ];
}

/** Get message type border color for speech bubbles */
export function getMessageColor(messageType: string): string {
  switch (messageType) {
    case "ANALYSIS":
    case "PROPOSAL":
      return "#3b82f6";
    case "AGREEMENT":
      return "#22c55e";
    case "DISAGREEMENT":
      return "#ef4444";
    case "REVIEW":
      return "#f59e0b";
    case "STATUS_UPDATE":
      return "#6b7280";
    default:
      return "#a78bfa";
  }
}
