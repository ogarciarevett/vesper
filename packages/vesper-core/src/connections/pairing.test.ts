import { describe, expect, test } from "bun:test";
import { stripSensitive } from "./audit.ts";
import { isPairable, newPairingNonce, PAIRING_TTL_MS } from "./pairing.ts";
import { channelStates } from "./state.ts";
import type { ChannelHandler } from "./types.ts";

const baseHandler = {
  descriptor: { id: "telegram" },
  authenticate: async () => {},
  send: async () => {},
  receive: () => ({ stop() {} }),
} as unknown as ChannelHandler;

describe("isPairable", () => {
  test("true when the handler implements startPairing", () => {
    const pairable = {
      ...baseHandler,
      startPairing: () => ({ stop() {}, updates: () => (async function* () {})() }),
    } as unknown as ChannelHandler;
    expect(isPairable(pairable)).toBe(true);
  });

  test("false when the handler omits startPairing", () => {
    expect(isPairable(baseHandler)).toBe(false);
  });
});

describe("newPairingNonce", () => {
  test("is Telegram-start safe, sized, and unique per call", () => {
    const a = newPairingNonce();
    const b = newPairingNonce();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThanOrEqual(20);
    expect(a.length).toBeLessThanOrEqual(64);
  });
});

test("PAIRING_TTL_MS is a positive duration", () => {
  expect(PAIRING_TTL_MS).toBeGreaterThan(0);
});

describe("channelStates pairable flag", () => {
  test("telegram + discord + signal are pairable; cloud whatsapp is not", () => {
    const states = channelStates({});
    const byId = (id: string) => states.find((s) => s.id === id);
    expect(byId("telegram")?.pairable).toBe(true);
    expect(byId("discord")?.pairable).toBe(true);
    expect(byId("whatsapp")?.pairable).toBe(false);
    expect(byId("signal")?.pairable).toBe(true);
  });

  test("signal ships a handler, so it reports available (send-only v1)", () => {
    const signal = channelStates({}).find((s) => s.id === "signal");
    expect(signal?.available).toBe(true);
    expect(signal?.pairable).toBe(true);
  });
});

describe("audit redaction covers pairing secrets", () => {
  test("nonce + qr are stripped while channel/chatId survive", () => {
    const out = stripSensitive({
      channel: "telegram",
      chatId: "123",
      nonce: "abc123",
      qr: "2@rotating-secret",
    });
    expect(out).toEqual({ channel: "telegram", chatId: "123" });
  });
});
