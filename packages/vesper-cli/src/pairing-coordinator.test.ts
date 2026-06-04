import { describe, expect, test } from "bun:test";
import {
  type ChannelDescriptor,
  type ChannelHandler,
  ChannelRegistry,
  type ChatSink,
  channelById,
  type InboundMessage,
  type Pairable,
  type PairingUpdate,
  type Stoppable,
  type Vault,
} from "@vesper/core";
import type { VesperConfig } from "./config.ts";
import { PairingCoordinator } from "./pairing-coordinator.ts";

function telegramDescriptor(): ChannelDescriptor {
  const descriptor = channelById("telegram");
  if (descriptor === undefined) throw new Error("telegram descriptor missing from catalog");
  return descriptor;
}
const TELEGRAM = telegramDescriptor();

const baseConfig = { cli: { default: null } } as unknown as VesperConfig;

function fakeVault(entries: Record<string, string> = {}): Vault {
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

/** A fake handler that pairs by watching inbound for the literal text "LINK". */
function fakePairable(): ChannelHandler & Pairable {
  return {
    descriptor: TELEGRAM,
    authenticate: async () => {},
    send: async () => {},
    receive: () => ({ stop() {} }),
    startPairing(deps) {
      let settle!: (u: PairingUpdate) => void;
      const outcome = new Promise<PairingUpdate>((r) => {
        settle = r;
      });
      let sub: Stoppable | undefined;
      return {
        updates: async function* () {
          yield {
            status: "awaiting",
            prompt: { kind: "link", data: "deeplink", humanHint: "scan", expiresAt: 1 },
          };
          sub = deps.subscribeInbound?.((m) => {
            if (m.text === "LINK") settle({ status: "linked", chatId: m.chatId, label: m.from });
          });
          const final = await outcome;
          sub?.stop();
          yield final;
        },
        stop() {
          sub?.stop();
          settle({ status: "expired" });
        },
      };
    },
  };
}

/** A fake handler with no pairing capability. */
function fakePlain(): ChannelHandler {
  return {
    descriptor: TELEGRAM,
    authenticate: async () => {},
    send: async () => {},
    receive: () => ({ stop() {} }),
  };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("PairingCoordinator", () => {
  test("reuses a running handler, multiplexes inbound, and persists defaultChatId on link", async () => {
    const registry = new ChannelRegistry([fakePairable()]);
    let saved: VesperConfig | undefined;
    const coordinator = new PairingCoordinator({
      registry,
      vault: fakeVault(),
      load: async () => baseConfig,
      save: async (c) => {
        saved = c;
      },
    });

    const sinkCalls: InboundMessage[] = [];
    const realSink: ChatSink = async (m) => {
      sinkCalls.push(m);
    };
    const tapped = coordinator.tap(realSink);

    const session = await coordinator.startPairing("telegram");
    const it = session.updates()[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.value).toMatchObject({ status: "awaiting" });

    const secondP = it.next();
    await tick();
    await tapped({ channel: "telegram", chatId: "55", from: "omar", text: "LINK", ts: 1 });
    const second = await secondP;
    expect(second.value).toEqual({ status: "linked", chatId: "55", label: "omar" });

    // The real chat sink ALSO saw the message (single long-poll, multiplexed),
    expect(sinkCalls).toHaveLength(1);
    // and the captured chat id was persisted + the channel enabled.
    expect(saved?.connections?.telegram).toMatchObject({
      enabled: true,
      params: { defaultChatId: "55" },
    });
  });

  test("unknown channel yields an error session", async () => {
    const coordinator = new PairingCoordinator({
      registry: new ChannelRegistry(),
      vault: fakeVault(),
      load: async () => baseConfig,
      save: async () => {},
    });
    const session = await coordinator.startPairing("nope");
    const first = await session.updates()[Symbol.asyncIterator]().next();
    expect(first.value).toMatchObject({ status: "error" });
  });

  test("a running but non-pairable handler yields an error session", async () => {
    const coordinator = new PairingCoordinator({
      registry: new ChannelRegistry([fakePlain()]),
      vault: fakeVault(),
      load: async () => baseConfig,
      save: async () => {},
    });
    const session = await coordinator.startPairing("telegram");
    const first = await session.updates()[Symbol.asyncIterator]().next();
    expect(first.value).toMatchObject({ status: "error" });
  });
});
