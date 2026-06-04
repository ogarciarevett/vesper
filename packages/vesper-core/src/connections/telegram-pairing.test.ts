import { describe, expect, test } from "bun:test";
import type { Capability } from "../capabilities/index.ts";
import type { Vault } from "../vault/index.ts";
import type { FetchFn } from "./fetch.ts";
import { TelegramHandler } from "./telegram.ts";
import type { InboundMessage, Stoppable } from "./types.ts";

const GRANTED: readonly Capability[] = ["NETWORK_FETCH", "READ_VAULT"];

function fakeVault(entries: Record<string, string>): Vault {
  return {
    async get(key) {
      const v = entries[key];
      if (v === undefined) throw new Error(`no such key ${key}`);
      return v;
    },
    async set() {},
    async delete() {},
    async list() {
      return Object.keys(entries).sort();
    },
  };
}

function scriptedFetch(responder: (method: string, body: unknown) => unknown): FetchFn {
  return async (input, init) => {
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) : undefined;
    const method = input.split("/").pop()?.split("?")[0] ?? "";
    return new Response(JSON.stringify(responder(method, body)), {
      headers: { "content-type": "application/json" },
    });
  };
}

/** A controllable inbound bus: a `subscribeInbound` seam plus an `emit` to push messages. */
function inboundBus() {
  const listeners = new Set<(m: InboundMessage) => void>();
  let stoppedFlag = false;
  const subscribeInbound = (on: (m: InboundMessage) => void): Stoppable => {
    listeners.add(on);
    return {
      stop() {
        listeners.delete(on);
        stoppedFlag = true;
      },
    };
  };
  return {
    subscribeInbound,
    emit: (m: InboundMessage) => {
      for (const l of listeners) l(m);
    },
    stopped: () => stoppedFlag,
  };
}

const getMeOk = (method: string): unknown =>
  method === "getMe"
    ? { ok: true, result: { id: 1, is_bot: true, username: "vesperbot" } }
    : { ok: true, result: {} };

const nonceFromLink = (link: string): string => new URL(link).searchParams.get("start") ?? "";

/** Flush microtasks + a macrotask so the generator registers its inbound subscription. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("TelegramHandler pairing", () => {
  test("awaits a t.me deep link, then auto-captures chatId on /start <nonce>", async () => {
    const handler = new TelegramHandler({ granted: GRANTED, fetchFn: scriptedFetch(getMeOk) });
    await handler.authenticate(fakeVault({ telegram_bot_token: "t" }));

    const bus = inboundBus();
    const session = handler.startPairing({
      vault: fakeVault({}),
      subscribeInbound: bus.subscribeInbound,
    });
    const it = session.updates()[Symbol.asyncIterator]();

    const first = await it.next();
    expect(first.value).toMatchObject({ status: "awaiting" });
    const prompt = (first.value as { prompt: { kind: string; data: string } }).prompt;
    expect(prompt.kind).toBe("link");
    expect(prompt.data).toContain("https://t.me/vesperbot?start=");
    const nonce = nonceFromLink(prompt.data);
    expect(nonce.length).toBeGreaterThan(0);

    const secondP = it.next();
    await tick();
    bus.emit({ channel: "telegram", chatId: "4242", from: "omar", text: `/start ${nonce}`, ts: 1 });
    const second = await secondP;
    expect(second.value).toEqual({ status: "linked", chatId: "4242", label: "omar" });
    // The inbound subscription is released once linked.
    expect(bus.stopped()).toBe(true);
  });

  test("ignores a /start carrying the wrong nonce; stop() yields expired", async () => {
    const handler = new TelegramHandler({ granted: GRANTED, fetchFn: scriptedFetch(getMeOk) });
    await handler.authenticate(fakeVault({ telegram_bot_token: "t" }));

    const bus = inboundBus();
    const session = handler.startPairing({
      vault: fakeVault({}),
      subscribeInbound: bus.subscribeInbound,
    });
    const it = session.updates()[Symbol.asyncIterator]();
    await it.next(); // awaiting

    const secondP = it.next();
    await tick();
    bus.emit({ channel: "telegram", chatId: "1", from: "x", text: "/start WRONG", ts: 1 });
    session.stop();
    const second = await secondP;
    expect(second.value).toEqual({ status: "expired" });
  });

  test("errors when no inbound stream is provided", async () => {
    const handler = new TelegramHandler({ granted: GRANTED, fetchFn: scriptedFetch(getMeOk) });
    await handler.authenticate(fakeVault({ telegram_bot_token: "t" }));
    const session = handler.startPairing({ vault: fakeVault({}) });
    const first = await session.updates()[Symbol.asyncIterator]().next();
    expect(first.value).toMatchObject({ status: "error" });
  });
});
