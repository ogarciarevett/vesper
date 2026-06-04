import { describe, expect, test } from "bun:test";
import {
  type ChannelHandler,
  ChannelRegistry,
  type FetchFn,
  type InboundMessage,
  type OutboundIntent,
  type Vault,
} from "@vesper/core";
import { buildChannelRegistry, makeChannelSink } from "./connections-wiring.ts";

function fakeVault(initial: Record<string, string> = {}): Vault {
  const store = new Map(Object.entries(initial));
  return {
    async get(key) {
      const v = store.get(key);
      if (v === undefined) throw new Error(`not_found: ${key}`);
      return v;
    },
    async set(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
    async list() {
      return [...store.keys()];
    },
  };
}

/** A fetch that answers Telegram getMe with a valid bot envelope (no network). */
const getMeOk: FetchFn = async () =>
  new Response(JSON.stringify({ ok: true, result: { id: 1, is_bot: true, username: "bot" } }), {
    headers: { "content-type": "application/json" },
  });

const telegramWiring = {
  telegram: { enabled: true, vaultKey: "telegram_bot_token", allowedHosts: ["api.telegram.org"] },
} as const;

describe("buildChannelRegistry", () => {
  test("registers an available, enabled, configured channel that authenticates", async () => {
    const { registry, runningIds } = await buildChannelRegistry({
      connections: telegramWiring,
      vault: fakeVault({ telegram_bot_token: "123:ABC" }),
      fetchFn: getMeOk,
    });
    expect(runningIds).toEqual(["telegram"]);
    expect(registry.byId("telegram")).toBeDefined();
  });

  test("skips a channel with no stored token (authenticate fails) without throwing", async () => {
    const { runningIds } = await buildChannelRegistry({
      connections: telegramWiring,
      vault: fakeVault(), // no token
      fetchFn: getMeOk,
    });
    expect(runningIds).toEqual([]);
  });

  test("skips a disabled channel", async () => {
    const { runningIds } = await buildChannelRegistry({
      connections: {
        telegram: { enabled: false, vaultKey: "telegram_bot_token", allowedHosts: [] },
      },
      vault: fakeVault({ telegram_bot_token: "x" }),
      fetchFn: getMeOk,
    });
    expect(runningIds).toEqual([]);
  });

  test("skips a channel with no shipped handler (no plugin)", async () => {
    const { runningIds } = await buildChannelRegistry({
      connections: {
        discord: { enabled: true, vaultKey: "discord_bot_token", allowedHosts: ["discord.com"] },
      },
      vault: fakeVault({ discord_bot_token: "x" }),
      fetchFn: getMeOk,
    });
    expect(runningIds).toEqual([]);
  });
});

/** A fake channel handler that records every outbound send. */
function spyHandler(sent: OutboundIntent[]): ChannelHandler {
  return {
    descriptor: { id: "telegram", displayName: "Telegram" } as ChannelHandler["descriptor"],
    async authenticate() {},
    async send(intent) {
      sent.push(intent);
    },
    receive: () => ({ stop() {} }),
  };
}

describe("makeChannelSink", () => {
  function inbound(text: string): InboundMessage {
    return { channel: "telegram", chatId: "42", from: "user", text, ts: 0 };
  }

  test("forwards inbound to /api/chat and delivers the reply back over the channel", async () => {
    const sent: OutboundIntent[] = [];
    const registry = new ChannelRegistry([spyHandler(sent)]);
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchFn: FetchFn = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ sessionId: "sess-1", reply: "hi back" }), {
        headers: { "content-type": "application/json" },
      });
    };
    const sink = makeChannelSink({ baseUrl: "http://127.0.0.1:4317", registry, fetchFn });

    await sink(inbound("hello"));
    expect(calls[0]?.url).toBe("http://127.0.0.1:4317/api/chat");
    expect(sent).toEqual([{ kind: "reply", chatId: "42", text: "hi back" }]);

    // A second message from the same chat reuses the session id from the first reply.
    await sink(inbound("again"));
    expect((calls[1]?.body as { sessionId?: string }).sessionId).toBe("sess-1");
  });

  test("delivers nothing when the chatbot reply is empty", async () => {
    const sent: OutboundIntent[] = [];
    const registry = new ChannelRegistry([spyHandler(sent)]);
    const fetchFn: FetchFn = async () =>
      new Response(JSON.stringify({ sessionId: "s", reply: "" }), {
        headers: { "content-type": "application/json" },
      });
    const sink = makeChannelSink({ baseUrl: "http://127.0.0.1:4317", registry, fetchFn });
    await sink(inbound("hello"));
    expect(sent).toEqual([]);
  });
});
