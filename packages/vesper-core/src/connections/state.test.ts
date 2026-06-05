import { describe, expect, test } from "bun:test";
import { type ChannelState, channelStates } from "./state.ts";

function byId(states: ChannelState[], id: string): ChannelState {
  const found = states.find((s) => s.id === id);
  if (found === undefined) throw new Error(`no state for ${id}`);
  return found;
}

describe("channelStates", () => {
  test("a configured + enabled + running telegram reports all true; available from the plugin", () => {
    const states = channelStates({
      wiring: { telegram: { enabled: true, vaultKey: "telegram_bot_token", allowedHosts: [] } },
      storedKeys: ["telegram_bot_token"],
      runningIds: ["telegram"],
    });
    const tg = byId(states, "telegram");
    expect(tg).toMatchObject({
      available: true,
      configured: true,
      enabled: true,
      running: true,
    });
  });

  test("a channel with no built-in handler is never available or running", () => {
    // whatsapp-web ships no BUILT-IN plugin (the opt-in package registers it at
    // runtime in the daemon); in core it is unavailable.
    const states = channelStates({ runningIds: ["whatsapp-web"] });
    const wweb = byId(states, "whatsapp-web");
    expect(wweb.available).toBe(false);
    // Even if runningIds claims it, an unavailable channel must never read as running.
    expect(wweb.running).toBe(false);
    expect(wweb.configured).toBe(false);
    expect(wweb.enabled).toBe(false);
  });

  test("configured falls back to the descriptor vault key when wiring omits it", () => {
    const states = channelStates({ storedKeys: ["telegram_bot_token"] });
    expect(byId(states, "telegram").configured).toBe(true);
  });

  test("empty input yields a row per catalog channel, all unconfigured", () => {
    const states = channelStates({});
    expect(states.length).toBeGreaterThanOrEqual(4);
    expect(states.every((s) => !s.configured && !s.enabled && !s.running)).toBe(true);
  });
});
