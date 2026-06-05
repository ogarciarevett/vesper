import { describe, expect, test } from "bun:test";
import {
  type ChannelHandler,
  type ChannelId,
  ChannelRegistry,
  type OutboundIntent,
  openStore,
  type Store,
} from "@vesper/core";
import type { VesperConfig } from "./config.ts";
import { makeNotifyFn } from "./make-notify.ts";

/** A fake channel handler that records outbound sends and may throw on send. */
function fakeHandler(
  id: ChannelId,
  opts: { throwOnSend?: boolean } = {},
): { handler: ChannelHandler; sends: OutboundIntent[] } {
  const sends: OutboundIntent[] = [];
  const handler: ChannelHandler = {
    descriptor: {
      id,
      displayName: id,
      transport: "long-poll",
      allowedHosts: ["example.com"],
      vaultKeys: [],
      docsUrl: "https://example.com",
      status: "ready",
    },
    authenticate: async () => {},
    send: async (intent) => {
      if (opts.throwOnSend) throw new Error("transport down");
      sends.push(intent);
    },
    receive: () => ({ stop() {} }),
  };
  return { handler, sends };
}

function registryWith(...handlers: ChannelHandler[]): ChannelRegistry {
  return new ChannelRegistry(handlers);
}

/** Minimal config with a connections block keyed by channel. */
function config(opts: {
  connections?: VesperConfig["connections"];
  notify?: VesperConfig["notify"];
}): VesperConfig {
  return {
    cli: { adapters: {} },
    ...(opts.connections !== undefined ? { connections: opts.connections } : {}),
    ...(opts.notify !== undefined ? { notify: opts.notify } : {}),
  };
}

function memStore(): Store {
  const store = openStore(":memory:");
  store.migrate();
  return store;
}

describe("makeNotifyFn — resolution", () => {
  test("no_channel when the registry is not yet built", async () => {
    const notify = makeNotifyFn({ getRegistry: () => undefined, config: config({}) });
    expect(await notify({ text: "hi" })).toEqual({ delivered: false, reason: "no_channel" });
  });

  test("no_channel when no channel is running", async () => {
    const notify = makeNotifyFn({ getRegistry: () => registryWith(), config: config({}) });
    expect(await notify({ text: "hi" })).toEqual({ delivered: false, reason: "no_channel" });
  });

  test("no_channel when an explicitly requested channel is not running", async () => {
    const notify = makeNotifyFn({
      getRegistry: () => registryWith(fakeHandler("telegram").handler),
      config: config({
        connections: {
          telegram: {
            enabled: true,
            vaultKey: "k",
            allowedHosts: [],
            params: { defaultChatId: "1" },
          },
        },
      }),
    });
    expect(await notify({ text: "hi", channel: "discord" })).toEqual({
      delivered: false,
      reason: "no_channel",
    });
  });

  test("no_destination when the resolved channel has no paired chat id", async () => {
    const notify = makeNotifyFn({
      getRegistry: () => registryWith(fakeHandler("telegram").handler),
      config: config({
        connections: { telegram: { enabled: true, vaultKey: "k", allowedHosts: [] } },
        notify: { defaultChannel: "telegram" },
      }),
    });
    expect(await notify({ text: "hi" })).toEqual({
      delivered: false,
      channel: "telegram",
      reason: "no_destination",
    });
  });

  test("prefers config.notify.defaultChannel when running", async () => {
    const tg = fakeHandler("telegram");
    const dc = fakeHandler("discord");
    const notify = makeNotifyFn({
      getRegistry: () => registryWith(tg.handler, dc.handler),
      config: config({
        connections: {
          telegram: {
            enabled: true,
            vaultKey: "k",
            allowedHosts: [],
            params: { defaultChatId: "111" },
          },
          discord: {
            enabled: true,
            vaultKey: "k",
            allowedHosts: [],
            params: { defaultChatId: "222" },
          },
        },
        notify: { defaultChannel: "discord" },
      }),
    });
    const outcome = await notify({ text: "hi" });
    expect(outcome).toEqual({ delivered: true, channel: "discord" });
    expect(dc.sends).toEqual([{ kind: "notify", chatId: "222", text: "hi" }]);
    expect(tg.sends).toHaveLength(0);
  });

  test("falls back to the first running channel with a paired destination", async () => {
    const tg = fakeHandler("telegram");
    const notify = makeNotifyFn({
      getRegistry: () => registryWith(tg.handler),
      config: config({
        connections: {
          telegram: {
            enabled: true,
            vaultKey: "k",
            allowedHosts: [],
            params: { defaultChatId: "111" },
          },
        },
      }),
    });
    expect(await notify({ text: "yo" })).toEqual({ delivered: true, channel: "telegram" });
    expect(tg.sends).toEqual([{ kind: "notify", chatId: "111", text: "yo" }]);
  });

  test("an explicit chatId overrides the paired default", async () => {
    const tg = fakeHandler("telegram");
    const notify = makeNotifyFn({
      getRegistry: () => registryWith(tg.handler),
      config: config({
        connections: {
          telegram: {
            enabled: true,
            vaultKey: "k",
            allowedHosts: [],
            params: { defaultChatId: "111" },
          },
        },
      }),
    });
    await notify({ text: "yo", channel: "telegram", chatId: "999" });
    expect(tg.sends).toEqual([{ kind: "notify", chatId: "999", text: "yo" }]);
  });
});

describe("makeNotifyFn — delivery + audit", () => {
  const conns: VesperConfig["connections"] = {
    telegram: { enabled: true, vaultKey: "k", allowedHosts: [], params: { defaultChatId: "111" } },
  };

  test("send_failed (never throws) when the handler throws, and audits the failure", async () => {
    const store = memStore();
    const notify = makeNotifyFn({
      getRegistry: () => registryWith(fakeHandler("telegram", { throwOnSend: true }).handler),
      config: config({ connections: conns }),
      store,
    });
    expect(await notify({ text: "boom" })).toEqual({
      delivered: false,
      channel: "telegram",
      reason: "send_failed",
    });
    const events = store.listEvents({ source: "connections" });
    expect(events.map((e) => e.kind)).toEqual(["notification_failed"]);
    store.close();
  });

  test("audits notification_sent with the channel but never the body or chat id", async () => {
    const store = memStore();
    const notify = makeNotifyFn({
      getRegistry: () => registryWith(fakeHandler("telegram").handler),
      config: config({ connections: conns }),
      store,
    });
    await notify({ text: "a private message body" });
    const events = store.listEvents({ source: "connections" });
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("notification_sent");
    expect(events[0]?.payload).toEqual({ channel: "telegram" });
    // The body and the destination must not appear anywhere in the serialized row.
    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toContain("a private message body");
    expect(serialized).not.toContain("111");
    store.close();
  });
});
