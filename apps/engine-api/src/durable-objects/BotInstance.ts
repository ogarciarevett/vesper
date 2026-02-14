import { DurableObject } from "cloudflare:workers";
import { AiService } from "../ai/AiService";
import { HyperliquidClient } from "@repo/hyperliquid-sdk";
import { StorageAdapter } from "../storage/StorageAdapter";
import { SimpleStrategy } from "../skills/strategies/SimpleStrategy";

interface BotState {
  isRunning: boolean;
  startedAt: number | null;
  tickCount: number;
  lastTick: number | null;
  lastDecision: any | null;
  errors: number;
}

export class BotInstance extends DurableObject {
  state: DurableObjectState;
  env: Env;
  storage: StorageAdapter;
  strategy: SimpleStrategy;
  botState: BotState;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.state = state;
    this.env = env;
    this.storage = new StorageAdapter(state, env.OPENCLAW_DATA);
    this.strategy = new SimpleStrategy();
    this.botState = {
      isRunning: false,
      startedAt: null,
      tickCount: 0,
      lastTick: null,
      lastDecision: null,
      errors: 0,
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Restore persisted state
    const saved = await this.ctx.storage.get<BotState>("botState");
    if (saved) this.botState = saved;

    if (path.endsWith("/start")) {
      const currentAlarm = await this.ctx.storage.getAlarm();
      if (!currentAlarm) {
        await this.ctx.storage.setAlarm(Date.now() + 1000);
      }
      this.botState.isRunning = true;
      this.botState.startedAt = this.botState.startedAt || Date.now();
      await this.ctx.storage.put("botState", this.botState);
      return Response.json({ ok: true, message: "Bot started", state: this.botState });
    }

    if (path.endsWith("/stop")) {
      await this.ctx.storage.deleteAlarm();
      this.botState.isRunning = false;
      await this.ctx.storage.put("botState", this.botState);
      return Response.json({ ok: true, message: "Bot stopped", state: this.botState });
    }

    if (path.endsWith("/status")) {
      const currentAlarm = await this.ctx.storage.getAlarm();
      return Response.json({
        ...this.botState,
        isRunning: !!currentAlarm,
        id: this.state.id.toString(),
        strategy: this.strategy.name,
        uptime: this.botState.startedAt ? Date.now() - this.botState.startedAt : 0,
      });
    }

    if (path.endsWith("/logs")) {
      const logs = await this.ctx.storage.get<any[]>("recentLogs") || [];
      return Response.json({ logs });
    }

    return Response.json({ status: "Bot Instance Active", id: this.state.id.toString() });
  }

  async alarm() {
    console.log("Bot Tick...");
    
    const saved = await this.ctx.storage.get<BotState>("botState");
    if (saved) this.botState = saved;

    try {
        const ai = new AiService(this.env);
        const hl = new HyperliquidClient({
            privateKey: this.env.HL_PRIVATE_KEY,
            testnet: this.env.HYPERLIQUID_TESTNET === "true" || true
        });

        const decision = await this.strategy.analyze(hl);

        console.log(`[Bot:${this.state.id.toString()}] Strategy Decision:`, decision);

        this.botState.tickCount++;
        this.botState.lastTick = Date.now();
        this.botState.lastDecision = decision;

        // Keep recent logs in memory (last 50)
        const logs = await this.ctx.storage.get<any[]>("recentLogs") || [];
        logs.unshift({ timestamp: Date.now(), decision, strategy: this.strategy.name });
        if (logs.length > 50) logs.length = 50;
        await this.ctx.storage.put("recentLogs", logs);

        // Also persist to R2
        await this.storage.saveLog(this.state.id.toString(), {
            timestamp: Date.now(),
            decision,
            strategy: this.strategy.name
        });

    } catch (err) {
        console.error("Bot Error:", err);
        this.botState.errors++;
        
        const logs = await this.ctx.storage.get<any[]>("recentLogs") || [];
        logs.unshift({ timestamp: Date.now(), error: String(err) });
        if (logs.length > 50) logs.length = 50;
        await this.ctx.storage.put("recentLogs", logs);

        await this.storage.saveLog(this.state.id.toString(), {
            timestamp: Date.now(),
            error: String(err)
        });
    }

    await this.ctx.storage.put("botState", this.botState);

    // Schedule next tick
    await this.ctx.storage.setAlarm(Date.now() + 5000); 
  }
}
