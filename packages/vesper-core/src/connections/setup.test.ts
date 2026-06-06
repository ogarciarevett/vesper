import { describe, expect, test } from "bun:test";
import { CHANNEL_SETUPS, channelSetupById, NEED_USER_LOGIN } from "./setup.ts";

describe("channelSetupById", () => {
  test("resolves the token channels and nothing else", () => {
    expect(channelSetupById("telegram")?.id).toBe("telegram");
    expect(channelSetupById("discord")?.id).toBe("discord");
    // Device-link channels onboard via pairing (QR), not an automated token setup.
    expect(channelSetupById("signal")).toBeUndefined();
    expect(channelSetupById("whatsapp-web")).toBeUndefined();
    expect(channelSetupById("nope")).toBeUndefined();
  });
});

describe("setup prompts", () => {
  test("each prompt names the channel, references the agent-browser tool, and the sentinel", () => {
    for (const spec of CHANNEL_SETUPS) {
      const prompt = spec.buildPrompt("My Channel");
      expect(prompt).toContain("My Channel");
      expect(prompt.toLowerCase()).toContain("agent-browser");
      expect(prompt).toContain(NEED_USER_LOGIN);
    }
  });
});

describe("telegram parseToken (strict)", () => {
  const tg = channelSetupById("telegram");
  if (tg === undefined) throw new Error("telegram setup missing");

  test("extracts a real BotFather token from surrounding chatter", () => {
    const out =
      "Done! Your bot token is:\n123456789:AAH9xVbq1Yc-Z_kPretendTokenABCDEFGHIJ012\nKeep it safe.";
    expect(tg.parseToken(out)).toBe("123456789:AAH9xVbq1Yc-Z_kPretendTokenABCDEFGHIJ012");
  });

  test("returns null for the NEED_USER_LOGIN sentinel and for prose with no token", () => {
    expect(tg.parseToken(NEED_USER_LOGIN)).toBeNull();
    expect(tg.parseToken("I could not create the bot.")).toBeNull();
    // A bare number with a colon but too-short secret must NOT match (no false positive).
    expect(tg.parseToken("12:short")).toBeNull();
  });
});

describe("discord parseToken (strict)", () => {
  const dc = channelSetupById("discord");
  if (dc === undefined) throw new Error("discord setup missing");

  test("extracts a three-segment bot token", () => {
    const token = "MTAxMjM0NTY3ODkwMTIzNDU2Nzg.Gabcde.PretendDiscordHmacSegment_0123456789";
    expect(dc.parseToken(`Here is your token: ${token}`)).toBe(token);
  });

  test("returns null when there is no dotted token", () => {
    expect(dc.parseToken("Application created, but no token shown.")).toBeNull();
    expect(dc.parseToken(NEED_USER_LOGIN)).toBeNull();
  });
});
