import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { channelPluginById, unregisterChannelPlugin } from "@vesper/core";
import { loadOptionalChannels } from "./optional-channels.ts";

beforeEach(() => unregisterChannelPlugin("whatsapp-web"));
afterEach(() => unregisterChannelPlugin("whatsapp-web"));

describe("loadOptionalChannels", () => {
  test("resolves + registers the opt-in WhatsApp-Web plugin (lazy, self-driving)", async () => {
    // Not a built-in: invisible until the opt-in package is loaded.
    expect(channelPluginById("whatsapp-web")).toBeUndefined();

    const registered = await loadOptionalChannels();
    expect(registered).toContain("whatsapp-web");

    const plugin = channelPluginById("whatsapp-web");
    expect(plugin?.id).toBe("whatsapp-web");
    expect(plugin?.pairable).toBe(true);
    expect(plugin?.pairingNeedsInbound).toBe(false);
  });
});
