import { describe, expect, test } from "bun:test";
import {
  CHANNEL_CATALOG,
  channelById,
  isChannelId,
  isMcpId,
  MCP_CATALOG,
  mcpById,
} from "./catalog.ts";

describe("CHANNEL_CATALOG", () => {
  test("channel ids are unique", () => {
    const ids = CHANNEL_CATALOG.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every descriptor has a non-empty allowedHosts and docsUrl", () => {
    for (const d of CHANNEL_CATALOG) {
      expect(d.allowedHosts.length).toBeGreaterThan(0);
      expect(d.docsUrl.length).toBeGreaterThan(0);
    }
  });

  test("telegram + discord + whatsapp + signal are ready", () => {
    expect(channelById("telegram")?.status).toBe("ready");
    expect(channelById("discord")?.status).toBe("ready");
    expect(channelById("whatsapp")?.status).toBe("ready");
    expect(channelById("signal")?.status).toBe("ready");
  });

  test("telegram declares api.telegram.org and the bot-token vault key", () => {
    const telegram = channelById("telegram");
    expect(telegram?.allowedHosts).toEqual(["api.telegram.org"]);
    expect(telegram?.vaultKeys).toEqual(["telegram_bot_token"]);
  });

  test("channelById / isChannelId reject unknown ids", () => {
    expect(channelById("nope")).toBeUndefined();
    expect(isChannelId("telegram")).toBe(true);
    expect(isChannelId("nope")).toBe(false);
  });
});

describe("MCP_CATALOG", () => {
  test("has the 10 seed ids, unique", () => {
    const ids = MCP_CATALOG.map((d) => d.id);
    expect(ids.length).toBe(10);
    expect(new Set(ids).size).toBe(10);
    expect(ids).toEqual([
      "linear",
      "notion",
      "gmail",
      "google-calendar",
      "google-drive",
      "refero",
      "bigdata",
      "fmp",
      "ziprecruiter",
      "excalidraw",
    ]);
  });

  test("every entry declares a docsUrl and non-empty allowedHosts", () => {
    for (const d of MCP_CATALOG) {
      expect(d.docsUrl.length).toBeGreaterThan(0);
      expect(d.allowedHosts.length).toBeGreaterThan(0);
    }
  });

  test("mcpById / isMcpId reject unknown ids", () => {
    expect(mcpById("linear")?.displayName).toBe("Linear");
    expect(mcpById("nope")).toBeUndefined();
    expect(isMcpId("notion")).toBe(true);
    expect(isMcpId("nope")).toBe(false);
  });
});
