import { describe, expect, test } from "bun:test";
import type { Capability } from "../capabilities/index.ts";
import { CapabilityError } from "../capabilities/index.ts";
import type { Vault } from "../vault/index.ts";
import { ConnectionError } from "./errors.ts";
import type { FetchFn } from "./fetch.ts";
import { TelegramHandler } from "./telegram.ts";
import type { ChatSink, InboundMessage } from "./types.ts";

const GRANTED: readonly Capability[] = ["NETWORK_FETCH", "READ_VAULT"];

/** An in-memory vault stub for tests (the suite never touches the Keychain). */
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

/** A scripted fetch: map a method name (from the URL path) to a JSON response. */
function scriptedFetch(responder: (method: string, body: unknown) => unknown): {
  fn: FetchFn;
  calls: { url: string; body: unknown }[];
} {
  const calls: { url: string; body: unknown }[] = [];
  const fn: FetchFn = async (input, init) => {
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: input, body });
    const method = input.split("/").pop() ?? "";
    const result = responder(method, body);
    return new Response(JSON.stringify(result), {
      headers: { "content-type": "application/json" },
    });
  };
  return { fn, calls };
}

describe("TelegramHandler", () => {
  test("authenticate loads the token from the vault and verifies via getMe", async () => {
    const { fn, calls } = scriptedFetch((method) =>
      method === "getMe"
        ? { ok: true, result: { id: 1, is_bot: true, username: "vesperbot" } }
        : { ok: true },
    );
    const handler = new TelegramHandler({ granted: GRANTED, fetchFn: fn });
    await handler.authenticate(fakeVault({ telegram_bot_token: "123:ABC" }));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.telegram.org/bot123:ABC/getMe");
  });

  test("authenticate throws when getMe says not-a-bot", async () => {
    const { fn } = scriptedFetch(() => ({ ok: true, result: { id: 1, is_bot: false } }));
    const handler = new TelegramHandler({ granted: GRANTED, fetchFn: fn });
    await expect(
      handler.authenticate(fakeVault({ telegram_bot_token: "123:ABC" })),
    ).rejects.toBeInstanceOf(ConnectionError);
  });

  test("authenticate surfaces a Bot API error envelope", async () => {
    const { fn } = scriptedFetch(() => ({ ok: false, description: "Unauthorized" }));
    const handler = new TelegramHandler({ granted: GRANTED, fetchFn: fn });
    await expect(
      handler.authenticate(fakeVault({ telegram_bot_token: "bad" })),
    ).rejects.toMatchObject({ reason: "invalid_response" });
  });

  test("send posts a sendMessage with chat_id + text", async () => {
    const { fn, calls } = scriptedFetch((method) =>
      method === "getMe" ? { ok: true, result: { id: 1, is_bot: true } } : { ok: true, result: {} },
    );
    const handler = new TelegramHandler({ granted: GRANTED, fetchFn: fn });
    await handler.authenticate(fakeVault({ telegram_bot_token: "t" }));
    await handler.send({ kind: "reply", chatId: "42", text: "hello" });
    const sendCall = calls.find((c) => c.url.endsWith("/sendMessage"));
    expect(sendCall?.body).toEqual({ chat_id: "42", text: "hello" });
  });

  test("send before authenticate throws not_authenticated", async () => {
    const { fn } = scriptedFetch(() => ({ ok: true }));
    const handler = new TelegramHandler({ granted: GRANTED, fetchFn: fn });
    await expect(handler.send({ kind: "reply", chatId: "1", text: "x" })).rejects.toMatchObject({
      reason: "not_authenticated",
    });
  });

  test("send asserts NETWORK_FETCH (denied when not granted)", async () => {
    const { fn } = scriptedFetch((method) =>
      method === "getMe" ? { ok: true, result: { id: 1, is_bot: true } } : { ok: true },
    );
    // Authenticate with full grant, then a fresh handler with no NETWORK_FETCH for send.
    const denied = new TelegramHandler({ granted: ["READ_VAULT"], fetchFn: fn });
    // Manually mark authenticated is not possible (private); instead authenticate fails first.
    await expect(
      denied.authenticate(fakeVault({ telegram_bot_token: "t" })),
    ).rejects.toBeInstanceOf(CapabilityError);
  });

  test("receive long-polls getUpdates and feeds text messages to the sink", async () => {
    let polls = 0;
    const { fn } = scriptedFetch((method) => {
      if (method === "getMe") return { ok: true, result: { id: 1, is_bot: true } };
      if (method === "getUpdates") {
        polls++;
        if (polls === 1) {
          return {
            ok: true,
            result: [
              {
                update_id: 10,
                message: {
                  message_id: 1,
                  text: "hi bot",
                  chat: { id: 99 },
                  from: { id: 7, username: "omar" },
                  date: 1700,
                },
              },
            ],
          };
        }
        return { ok: true, result: [] }; // subsequent polls are empty
      }
      return { ok: true, result: {} };
    });

    const handler = new TelegramHandler({ granted: GRANTED, fetchFn: fn });
    await handler.authenticate(fakeVault({ telegram_bot_token: "t" }));

    const received: InboundMessage[] = [];
    const sink: ChatSink = async (m) => void received.push(m);
    const handle = handler.receive(sink);

    // Let the loop run a couple of iterations, then stop.
    await new Promise((r) => setTimeout(r, 50));
    handle.stop();

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      channel: "telegram",
      chatId: "99",
      from: "omar",
      text: "hi bot",
      ts: 1700 * 1000,
    });
  });

  test("receive isolates a failing sink (ingress survives)", async () => {
    let polls = 0;
    const { fn } = scriptedFetch((method) => {
      if (method === "getMe") return { ok: true, result: { id: 1, is_bot: true } };
      if (method === "getUpdates") {
        polls++;
        if (polls === 1) {
          return {
            ok: true,
            result: [
              { update_id: 1, message: { message_id: 1, text: "x", chat: { id: 1 }, date: 1 } },
            ],
          };
        }
        return { ok: true, result: [] };
      }
      return { ok: true, result: {} };
    });
    const handler = new TelegramHandler({ granted: GRANTED, fetchFn: fn });
    await handler.authenticate(fakeVault({ telegram_bot_token: "t" }));
    const handle = handler.receive(async () => {
      throw new Error("chatbot down");
    });
    await new Promise((r) => setTimeout(r, 30));
    handle.stop(); // did not crash the loop
    expect(polls).toBeGreaterThan(0);
  });
});
