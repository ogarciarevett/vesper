import { describe, expect, test } from "bun:test";
import type { Capability } from "../capabilities/index.ts";
import type { Vault } from "../vault/index.ts";
import { DiscordHandler } from "./discord.ts";
import type { FetchFn } from "./fetch.ts";
import type { InboundMessage, Stoppable } from "./types.ts";

const GRANTED: readonly Capability[] = ["NETWORK_FETCH", "READ_VAULT"];

/** A vault double: `get` returns the token; the rest are no-ops (the handler only reads). */
function vaultWith(token: string): Vault {
  return {
    get: async () => token,
    set: async () => {},
    delete: async () => {},
    async list() {
      return [];
    },
  };
}

/**
 * Script the REST seam by the last path segment. Discord returns the object
 * DIRECTLY (no `{ok,result}` envelope), so each responder value is the raw body.
 */
function scriptedFetch(responder: (segment: string) => unknown): FetchFn {
  return async (input) => {
    const segment = input.split("?")[0]?.split("/").pop() ?? "";
    return new Response(JSON.stringify(responder(segment)), {
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

/** REST responder: `/users/@me` is a bot; `oauth2/applications/@me` returns the app id. */
const restOk = (segment: string): unknown => (segment === "@me" ? { id: "self-1", bot: true } : {});

/**
 * The handler resolves the app id via `GET /oauth2/applications/@me`; both that
 * call and `/users/@me` end in the segment `@me`, so disambiguate by the FULL url.
 */
function appIdFetch(appId: string): FetchFn {
  return async (input) => {
    const body: unknown = input.includes("/oauth2/applications/@me")
      ? { id: appId }
      : { id: "self-1", bot: true };
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  };
}

const stateFromLink = (link: string): string => new URL(link).searchParams.get("state") ?? "";

/** Flush microtasks + a macrotask so the generator registers its inbound subscription. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("DiscordHandler pairing", () => {
  test("awaits an invite link, then auto-captures chatId on pair <nonce>", async () => {
    const handler = new DiscordHandler({ granted: GRANTED, fetchFn: appIdFetch("111222") });
    await handler.authenticate(vaultWith("tok"));

    const bus = inboundBus();
    const session = handler.startPairing({
      vault: vaultWith("tok"),
      subscribeInbound: bus.subscribeInbound,
    });
    const it = session.updates()[Symbol.asyncIterator]();

    const first = await it.next();
    expect(first.value).toMatchObject({ status: "awaiting" });
    const prompt = (first.value as { prompt: { kind: string; data: string } }).prompt;
    expect(prompt.kind).toBe("link");
    expect(prompt.data).toContain("https://discord.com/oauth2/authorize?");
    expect(prompt.data).toContain("client_id=111222");
    expect(prompt.data).toContain("permissions=");
    const nonce = stateFromLink(prompt.data);
    expect(nonce.length).toBeGreaterThan(0);

    const secondP = it.next();
    await tick();
    bus.emit({ channel: "discord", chatId: "c-42", from: "omar", text: `pair ${nonce}`, ts: 1 });
    const second = await secondP;
    expect(second.value).toEqual({ status: "linked", chatId: "c-42", label: "omar" });
    // The inbound subscription is released once linked.
    expect(bus.stopped()).toBe(true);
  });

  test("ignores a pair carrying the wrong nonce; stop() yields expired", async () => {
    const handler = new DiscordHandler({ granted: GRANTED, fetchFn: appIdFetch("111222") });
    await handler.authenticate(vaultWith("tok"));

    const bus = inboundBus();
    const session = handler.startPairing({
      vault: vaultWith("tok"),
      subscribeInbound: bus.subscribeInbound,
    });
    const it = session.updates()[Symbol.asyncIterator]();
    await it.next(); // awaiting

    const secondP = it.next();
    await tick();
    bus.emit({ channel: "discord", chatId: "c-1", from: "x", text: "pair WRONG", ts: 1 });
    session.stop();
    const second = await secondP;
    expect(second.value).toEqual({ status: "expired" });
  });

  test("errors when no inbound stream is provided", async () => {
    const handler = new DiscordHandler({ granted: GRANTED, fetchFn: appIdFetch("111222") });
    await handler.authenticate(vaultWith("tok"));
    const session = handler.startPairing({ vault: vaultWith("tok") });
    const first = await session.updates()[Symbol.asyncIterator]().next();
    expect(first.value).toMatchObject({ status: "error" });
  });

  test("errors when the application id cannot be resolved", async () => {
    const failingFetch: FetchFn = async (input) =>
      input.includes("/oauth2/applications/@me")
        ? new Response("nope", { status: 500 })
        : new Response(JSON.stringify({ id: "self-1", bot: true }), {
            headers: { "content-type": "application/json" },
          });
    const handler = new DiscordHandler({ granted: GRANTED, fetchFn: failingFetch });
    await handler.authenticate(vaultWith("tok"));
    const bus = inboundBus();
    const session = handler.startPairing({
      vault: vaultWith("tok"),
      subscribeInbound: bus.subscribeInbound,
    });
    const first = await session.updates()[Symbol.asyncIterator]().next();
    expect(first.value).toMatchObject({ status: "error" });
  });

  test("uses discord's direct-object REST envelope (no {ok,result} wrapper)", async () => {
    // scriptedFetch returns the body directly; authenticate must accept {id, bot}.
    const handler = new DiscordHandler({ granted: GRANTED, fetchFn: scriptedFetch(restOk) });
    await expect(handler.authenticate(vaultWith("tok"))).resolves.toBeUndefined();
  });
});
