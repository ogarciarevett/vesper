import { describe, expect, test } from "bun:test";
import type { PairingUpdate, SetupUpdate } from "@vesper/core";
import { runChannelSetup, runPairing } from "./connections.ts";

async function* seq(...updates: PairingUpdate[]): AsyncGenerator<PairingUpdate> {
  for (const u of updates) yield u;
}

async function* setupSeq(...updates: SetupUpdate[]): AsyncGenerator<SetupUpdate> {
  for (const u of updates) yield u;
}

describe("runPairing", () => {
  test("renders a scannable QR + hint on awaiting and returns 0 on linked", async () => {
    const out: string[] = [];
    const code = await runPairing(
      seq(
        {
          status: "awaiting",
          prompt: {
            kind: "link",
            data: "https://t.me/vesperbot?start=abc",
            humanHint: "scan me with your phone",
            expiresAt: 1,
          },
        },
        { status: "linked", chatId: "42", label: "omar" },
      ),
      (s) => out.push(s),
    );
    expect(code).toBe(0);
    const joined = out.join("\n");
    expect(joined).toContain("scan me with your phone");
    expect(joined).toContain("https://t.me/vesperbot?start=abc");
    expect(joined.toLowerCase()).toContain("linked");
    // A QR grid was actually rendered (half-block glyphs present).
    expect(joined).toMatch(/[█▀▄]/);
  });

  test("returns 1 on error", async () => {
    const code = await runPairing(seq({ status: "error", reason: "nope" }), () => {});
    expect(code).toBe(1);
  });

  test("returns 1 on expired", async () => {
    const code = await runPairing(seq({ status: "expired" }), () => {});
    expect(code).toBe(1);
  });
});

describe("runChannelSetup", () => {
  test("prints progress and returns 0 on configured", async () => {
    const out: string[] = [];
    const code = await runChannelSetup(
      setupSeq({ status: "working", message: "Setting up Telegram…" }, { status: "configured" }),
      (s) => out.push(s),
    );
    expect(code).toBe(0);
    const joined = out.join("\n");
    expect(joined).toContain("Setting up Telegram");
    expect(joined.toLowerCase()).toContain("set up");
  });

  test("returns 1 on awaiting_user and points at the manual fallback", async () => {
    const out: string[] = [];
    const code = await runChannelSetup(
      setupSeq({ status: "awaiting_user", reason: "Telegram needs you to sign in." }),
      (s) => out.push(s),
    );
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("connections set");
  });

  test("returns 1 on error", async () => {
    const code = await runChannelSetup(setupSeq({ status: "error", reason: "boom" }), () => {});
    expect(code).toBe(1);
  });
});
