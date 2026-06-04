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

  test("discord ships a plugin (Gateway handler)", () => {
    expect(channelPluginById("discord")).toBeDefined();
  });

  test("a channel with no shipped handler has no plugin (availability gate)", () => {
    expect(channelPluginById("whatsapp")).toBeUndefined();
    expect(channelPluginById("signal")).toBeUndefined();
    expect(channelPluginById("not-a-channel")).toBeUndefined();
  });

  test("CHANNEL_PLUGINS ids are unique", () => {
    const ids = CHANNEL_PLUGINS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
