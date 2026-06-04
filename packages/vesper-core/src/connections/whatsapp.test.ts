import { describe, expect, test } from "bun:test";
import type { Capability } from "../capabilities/index.ts";
import type { FetchFn } from "./fetch.ts";
import { WhatsAppHandler } from "./whatsapp.ts";

const GRANTED: readonly Capability[] = ["NETWORK_FETCH", "READ_VAULT"];
const vaultWith = (token: string) => ({ get: async () => token });
const okJson = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

function fakeFetch(handler: (url: string, init?: RequestInit) => Response): {
  fetchFn: FetchFn;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetchFn, calls };
}

describe("WhatsAppHandler", () => {
  test("authenticate requires a phoneNumberId param", async () => {
    const { fetchFn } = fakeFetch(() => okJson({ id: "x" }));
    const h = new WhatsAppHandler({ granted: GRANTED, fetchFn });
    await expect(h.authenticate(vaultWith("tok"))).rejects.toThrow(/phoneNumberId/);
  });

  test("authenticate verifies the phone number via the Cloud API", async () => {
    const { fetchFn, calls } = fakeFetch(() => okJson({ id: "PN1" }));
    const h = new WhatsAppHandler({ granted: GRANTED, fetchFn, phoneNumberId: "PN1" });
    await h.authenticate(vaultWith("tok"));
    expect(calls[0]?.url).toBe("https://graph.facebook.com/v21.0/PN1?fields=id");
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  test("send POSTs a WhatsApp text message to the recipient", async () => {
    const { fetchFn, calls } = fakeFetch(() => okJson({ messages: [{ id: "m1" }] }));
    const h = new WhatsAppHandler({ granted: GRANTED, fetchFn, phoneNumberId: "PN1" });
    await h.authenticate(vaultWith("tok"));
    await h.send({ kind: "notify", chatId: "+15551234567", text: "hello" });
    const post = calls.find((c) => c.init?.method === "POST");
    expect(post?.url).toBe("https://graph.facebook.com/v21.0/PN1/messages");
    expect(JSON.parse(String(post?.init?.body))).toEqual({
      messaging_product: "whatsapp",
      to: "+15551234567",
      type: "text",
      text: { body: "hello" },
    });
  });

  test("send surfaces a non-ok Cloud API response", async () => {
    const { fetchFn } = fakeFetch((url) =>
      url.includes("?fields=id") ? okJson({ id: "PN1" }) : new Response("nope", { status: 400 }),
    );
    const h = new WhatsAppHandler({ granted: GRANTED, fetchFn, phoneNumberId: "PN1" });
    await h.authenticate(vaultWith("tok"));
    await expect(h.send({ kind: "notify", chatId: "x", text: "y" })).rejects.toThrow(/send failed/);
  });

  test("receive is a no-op (send-only v1) — never feeds the sink", () => {
    const h = new WhatsAppHandler({ granted: GRANTED, phoneNumberId: "PN1" });
    let called = false;
    const stop = h.receive(async () => {
      called = true;
    });
    stop.stop();
    expect(called).toBe(false);
  });
});
