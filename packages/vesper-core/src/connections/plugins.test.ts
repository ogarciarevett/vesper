import { describe, expect, test } from "bun:test";
import { CHANNEL_GRANTS, CHANNEL_PLUGINS, channelPluginById } from "./plugins.ts";

describe("channel plugins", () => {
  test("telegram ships a plugin that builds a handler with the telegram descriptor", () => {
    const plugin = channelPluginById("telegram");
    expect(plugin).toBeDefined();
    const handler = plugin?.build({
      granted: CHANNEL_GRANTS,
      vaultKey: "telegram_bot_token",
      allowedHosts: ["api.telegram.org"],
      fetchFn: async () => new Response("{}"),
    });
    expect(handler?.descriptor.id).toBe("telegram");
  });

  test("discord and whatsapp ship plugins", () => {
    expect(channelPluginById("discord")).toBeDefined();
    expect(channelPluginById("whatsapp")).toBeDefined();
  });

  test("signal ships a self-driving pairable plugin (local signal-cli)", () => {
    const plugin = channelPluginById("signal");
    expect(plugin).toBeDefined();
    expect(plugin?.pairable).toBe(true);
    expect(plugin?.pairingNeedsInbound).toBe(false);
    const handler = plugin?.build({
      granted: CHANNEL_GRANTS,
      vaultKey: "signal_account",
      allowedHosts: ["127.0.0.1"],
    });
    expect(handler?.descriptor.id).toBe("signal");
  });

  test("an unknown channel id has no plugin (availability gate)", () => {
    expect(channelPluginById("not-a-channel")).toBeUndefined();
  });

  test("CHANNEL_PLUGINS ids are unique", () => {
    const ids = CHANNEL_PLUGINS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
