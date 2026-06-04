import { describe, expect, test } from "bun:test";
import type { Capability } from "../capabilities/index.ts";
import { DiscordHandler, type GatewayConnect, type GatewaySocket } from "./discord.ts";
import type { FetchFn, InboundMessage } from "./index.ts";

const GRANTED: readonly Capability[] = ["NETWORK_FETCH", "READ_VAULT"];

/** A vault double exposing only `get` (the subset the handler uses). */
function vaultWith(token: string): { get(key: string): Promise<string> } {
  return { get: async () => token };
}

/** Capture REST calls and answer them. */
function fakeFetch(handler: (url: string, init?: RequestInit) => Response): {
  fetchFn: FetchFn;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetchFn, calls };
}

/** A controllable Gateway: captures sent frames + lets the test push server frames. */
function fakeGateway() {
  const sent: Array<Record<string, unknown>> = [];
  let cbs: Parameters<GatewayConnect>[1] | null = null;
  let closed = false;
  const connect: GatewayConnect = (_url, handlers) => {
    cbs = handlers;
    const socket: GatewaySocket = {
      send: (data) => sent.push(JSON.parse(data)),
      close: () => {
        closed = true;
        handlers.onClose();
      },
    };
    queueMicrotask(() => handlers.onOpen());
    return socket;
  };
  return {
    connect,
    sent,
    isClosed: () => closed,
    emit: (payload: unknown) => cbs?.onMessage(JSON.stringify(payload)),
  };
}

const okJson = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

describe("DiscordHandler — REST", () => {
  test("authenticate verifies the bot via GET /users/@me", async () => {
    const { fetchFn, calls } = fakeFetch(() =>
      okJson({ id: "self-1", username: "vesperbot", bot: true }),
    );
    const h = new DiscordHandler({ granted: GRANTED, fetchFn });
    await h.authenticate(vaultWith("tok"));
    expect(calls[0]?.url).toBe("https://discord.com/api/v10/users/@me");
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe("Bot tok");
  });

  test("authenticate rejects a non-bot token", async () => {
    const { fetchFn } = fakeFetch(() => okJson({ id: "u", bot: false }));
    const h = new DiscordHandler({ granted: GRANTED, fetchFn });
    await expect(h.authenticate(vaultWith("tok"))).rejects.toThrow(/did not return a bot/);
  });

  test("send POSTs the content to the channel", async () => {
    const { fetchFn, calls } = fakeFetch((url) =>
      url.endsWith("/users/@me") ? okJson({ id: "self-1", bot: true }) : okJson({}),
    );
    const h = new DiscordHandler({ granted: GRANTED, fetchFn });
    await h.authenticate(vaultWith("tok"));
    await h.send({ kind: "reply", chatId: "123", text: "hello" });
    const post = calls.find((c) => c.init?.method === "POST");
    expect(post?.url).toBe("https://discord.com/api/v10/channels/123/messages");
    expect(JSON.parse(String(post?.init?.body))).toEqual({ content: "hello" });
  });
});

describe("DiscordHandler — Gateway receive", () => {
  test("identifies after HELLO and forwards a user MESSAGE_CREATE to the sink", async () => {
    const gw = fakeGateway();
    const { fetchFn } = fakeFetch(() => okJson({ id: "self-1", bot: true }));
    const h = new DiscordHandler({ granted: GRANTED, fetchFn, connect: gw.connect });
    await h.authenticate(vaultWith("tok"));

    const got: InboundMessage[] = [];
    const stop = h.receive(async (m) => {
      got.push(m);
    });

    gw.emit({ op: 10, d: { heartbeat_interval: 100000 } });
    const identify = gw.sent.find((f) => f.op === 2);
    expect(identify).toBeDefined();
    expect((identify?.d as { intents: number }).intents).toBe((1 << 9) | (1 << 12) | (1 << 15));

    gw.emit({
      op: 0,
      t: "MESSAGE_CREATE",
      s: 1,
      d: { channel_id: "c1", content: "hi vesper", author: { id: "user-2", username: "omar" } },
    });
    await Promise.resolve();
    expect(got).toEqual([
      { channel: "discord", chatId: "c1", from: "omar", text: "hi vesper", ts: got[0]?.ts ?? 0 },
    ]);
    stop.stop();
  });

  test("ignores messages from itself and from other bots", async () => {
    const gw = fakeGateway();
    const { fetchFn } = fakeFetch(() => okJson({ id: "self-1", bot: true }));
    const h = new DiscordHandler({ granted: GRANTED, fetchFn, connect: gw.connect });
    await h.authenticate(vaultWith("tok"));
    const got: InboundMessage[] = [];
    const stop = h.receive(async (m) => {
      got.push(m);
    });
    gw.emit({ op: 10, d: { heartbeat_interval: 100000 } });
    gw.emit({
      op: 0,
      t: "MESSAGE_CREATE",
      d: { channel_id: "c", content: "me", author: { id: "self-1" } },
    });
    gw.emit({
      op: 0,
      t: "MESSAGE_CREATE",
      d: { channel_id: "c", content: "bot", author: { id: "x", bot: true } },
    });
    await Promise.resolve();
    expect(got).toEqual([]);
    stop.stop();
  });

  test("sends a heartbeat on the interval from HELLO", async () => {
    const gw = fakeGateway();
    const { fetchFn } = fakeFetch(() => okJson({ id: "self-1", bot: true }));
    const h = new DiscordHandler({ granted: GRANTED, fetchFn, connect: gw.connect });
    const stop = h.receive(async () => {});
    gw.emit({ op: 10, d: { heartbeat_interval: 15 } });
    await new Promise((r) => setTimeout(r, 40));
    expect(gw.sent.some((f) => f.op === 1)).toBe(true);
    stop.stop();
  });

  test("refuses to connect when the gateway host is not allowlisted", () => {
    const gw = fakeGateway();
    const h = new DiscordHandler({
      granted: GRANTED,
      connect: gw.connect,
      allowedHosts: ["discord.com"], // gateway.discord.gg missing -> refused
    });
    expect(() => h.receive(async () => {})).toThrow(/not in the channel allowlist/);
  });

  test("refuses to connect without NETWORK_FETCH", () => {
    const gw = fakeGateway();
    const h = new DiscordHandler({ granted: ["READ_VAULT"], connect: gw.connect });
    expect(() => h.receive(async () => {})).toThrow();
  });
});
