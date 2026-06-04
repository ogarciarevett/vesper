import { describe, expect, test } from "bun:test";
import { ChannelRegistry } from "./registry.ts";
import type { ChannelDescriptor, ChannelHandler, ChannelId, ChatSink, Stoppable } from "./types.ts";

function descriptor(id: ChannelId): ChannelDescriptor {
  return {
    id,
    displayName: id,
    transport: "long-poll",
    allowedHosts: ["example.com"],
    vaultKeys: [],
    docsUrl: "https://example.com",
    status: "ready",
  };
}

/** A fake handler recording start/stop, optionally throwing on receive. */
function fakeHandler(
  id: ChannelId,
  opts: { throwOnReceive?: boolean; onStop?: () => void } = {},
): { handler: ChannelHandler; started: () => boolean } {
  let started = false;
  const handler: ChannelHandler = {
    descriptor: descriptor(id),
    authenticate: async () => {},
    send: async () => {},
    receive: (_sink: ChatSink): Stoppable => {
      if (opts.throwOnReceive) throw new Error("boom");
      started = true;
      return {
        stop() {
          opts.onStop?.();
        },
      };
    },
  };
  return { handler, started: () => started };
}

const sink: ChatSink = async () => {};

describe("ChannelRegistry", () => {
  test("is empty by default", () => {
    const reg = new ChannelRegistry();
    expect(reg.list()).toHaveLength(0);
    expect(reg.byId("telegram")).toBeUndefined();
  });

  test("register + byId + list", () => {
    const { handler } = fakeHandler("telegram");
    const reg = new ChannelRegistry([handler]);
    reg.register(fakeHandler("discord").handler);
    expect(reg.list()).toHaveLength(2);
    expect(reg.byId("telegram")).toBe(handler);
    expect(reg.byId("discord")?.descriptor.id).toBe("discord");
  });

  test("startAll starts every registered handler", () => {
    const a = fakeHandler("telegram");
    const b = fakeHandler("discord");
    const reg = new ChannelRegistry([a.handler, b.handler]);
    reg.startAll(sink);
    expect(a.started()).toBe(true);
    expect(b.started()).toBe(true);
  });

  test("isolates a throwing handler so the others still start", () => {
    const bad = fakeHandler("telegram", { throwOnReceive: true });
    const good = fakeHandler("discord");
    const reg = new ChannelRegistry([bad.handler, good.handler]);
    const handle = reg.startAll(sink); // must not throw
    expect(good.started()).toBe(true);
    handle.stop();
  });

  test("startAll's handle stops every started loop (idempotent)", () => {
    let stops = 0;
    const a = fakeHandler("telegram", { onStop: () => stops++ });
    const b = fakeHandler("discord", { onStop: () => stops++ });
    const reg = new ChannelRegistry([a.handler, b.handler]);
    const handle = reg.startAll(sink);
    handle.stop();
    handle.stop(); // idempotent — does not double-stop
    expect(stops).toBe(2);
  });
});
