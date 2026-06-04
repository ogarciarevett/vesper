import { describe, expect, test } from "bun:test";
import {
  type Capability,
  type InboundMessage,
  type PairingUpdate,
  type Vault,
  VaultError,
} from "@vesper/core";
import {
  type WASocket,
  type WASocketConfig,
  type WASocketFactory,
  WhatsAppWebHandler,
} from "./handler.ts";

const GRANTED: readonly Capability[] = ["READ_VAULT", "WRITE_VAULT"];
const KEY = "whatsapp_web_session";

/** An in-memory {@link Vault} that throws `VaultError(not_found)` for an absent key. */
function memoryVault(seed?: Record<string, string>): Vault & { store: Map<string, string> } {
  const store = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    store,
    get: async (key) => {
      const value = store.get(key);
      if (value === undefined) throw new VaultError("not_found", `no ${key}`);
      return value;
    },
    set: async (key, value) => {
      store.set(key, value);
    },
    delete: async (key) => {
      if (!store.delete(key)) throw new VaultError("not_found", `no ${key}`);
    },
    list: async () => [...store.keys()].sort(),
  };
}

/** A controllable Baileys socket: captures listeners + sent messages, lets a test emit events. */
function fakeSocket() {
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  const sent: Array<{ jid: string; text: string }> = [];
  let ended = false;
  const socket: WASocket = {
    ev: {
      on: (event, listener) => {
        const bucket = listeners.get(event) ?? [];
        bucket.push(listener);
        listeners.set(event, bucket);
      },
    },
    sendMessage: async (jid, content) => {
      sent.push({ jid, text: content.text });
      return {};
    },
    end: () => {
      ended = true;
    },
  };
  return {
    socket,
    sent,
    isEnded: () => ended,
    emit: (event: string, payload: unknown) => {
      for (const cb of listeners.get(event) ?? []) cb(payload);
    },
  };
}

/** A factory that records each built socket; the caller supplies the next fake. */
function recordingFactory(...sockets: ReturnType<typeof fakeSocket>[]): {
  factory: WASocketFactory;
  configs: WASocketConfig[];
} {
  const configs: WASocketConfig[] = [];
  let index = 0;
  const factory: WASocketFactory = (config) => {
    configs.push(config);
    const next = sockets[index++];
    if (next === undefined) throw new Error("recordingFactory: no more fake sockets");
    return next.socket;
  };
  return { factory, configs };
}

/** Drain an async-iterable of updates into an array. */
async function collect(updates: AsyncIterable<PairingUpdate>): Promise<PairingUpdate[]> {
  const out: PairingUpdate[] = [];
  for await (const update of updates) out.push(update);
  return out;
}

/** Spin the microtask/macrotask queue until `predicate` holds (the async `start()` settled). */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !predicate(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("WhatsAppWebHandler — descriptor", () => {
  test("uses the whatsapp-web catalog descriptor", () => {
    const h = new WhatsAppWebHandler({ granted: GRANTED });
    expect(h.descriptor.id).toBe("whatsapp-web");
    expect(h.descriptor.transport).toBe("qr-web");
  });
});

describe("WhatsAppWebHandler — startPairing", () => {
  test("yields one awaiting 'code' update per QR rotation, then linked + saves the vault", async () => {
    const sock = fakeSocket();
    const { factory, configs } = recordingFactory(sock);
    const vault = memoryVault();
    const h = new WhatsAppWebHandler({ granted: GRANTED, socketFactory: factory });

    const session = h.startPairing({ vault });
    const updatesPromise = collect(session.updates());

    // Wait until `start()` built the socket + registered listeners.
    await waitFor(() => configs.length > 0);
    expect(configs[0]?.printQRInTerminal).toBe(false);

    sock.emit("connection.update", { qr: "QR1" });
    sock.emit("connection.update", { qr: "QR2" });
    sock.emit("creds.update", {});
    sock.emit("connection.update", { connection: "open" });

    const updates = await updatesPromise;
    const awaiting = updates.filter((u) => u.status === "awaiting");
    expect(awaiting).toHaveLength(2);
    for (const u of awaiting) {
      if (u.status === "awaiting") expect(u.prompt.kind).toBe("code");
    }
    expect(awaiting[0]?.status === "awaiting" && awaiting[0].prompt.data).toBe("QR1");
    expect(awaiting[1]?.status === "awaiting" && awaiting[1].prompt.data).toBe("QR2");

    const last = updates.at(-1);
    expect(last?.status).toBe("linked");
    if (last?.status === "linked") expect(last.chatId).toBeUndefined();
    // saveCreds ran on open -> vault blob written.
    expect(vault.store.has(KEY)).toBe(true);
    expect(sock.isEnded()).toBe(true);
  });

  test("yields an error update on a non-recoverable connection close", async () => {
    const sock = fakeSocket();
    const { factory, configs } = recordingFactory(sock);
    const vault = memoryVault();
    const h = new WhatsAppWebHandler({ granted: GRANTED, socketFactory: factory });

    const session = h.startPairing({ vault });
    const updatesPromise = collect(session.updates());
    await waitFor(() => configs.length > 0);

    sock.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: new Error("boom") },
    });

    const updates = await updatesPromise;
    const last = updates.at(-1);
    expect(last?.status).toBe("error");
    if (last?.status === "error") expect(last.reason).toContain("boom");
  });

  test("stop() yields an expired update and ends the socket", async () => {
    const sock = fakeSocket();
    const { factory, configs } = recordingFactory(sock);
    const vault = memoryVault();
    const h = new WhatsAppWebHandler({ granted: GRANTED, socketFactory: factory });

    const session = h.startPairing({ vault });
    const updatesPromise = collect(session.updates());
    await waitFor(() => configs.length > 0);

    session.stop();
    session.stop(); // idempotent

    const updates = await updatesPromise;
    expect(updates.at(-1)?.status).toBe("expired");
    expect(sock.isEnded()).toBe(true);
  });
});

describe("WhatsAppWebHandler — authenticate", () => {
  test("throws not_authenticated when no session blob is stored", async () => {
    const h = new WhatsAppWebHandler({ granted: GRANTED });
    await expect(h.authenticate(memoryVault())).rejects.toMatchObject({
      reason: "not_authenticated",
    });
  });

  test("loads the stored session blob", async () => {
    // Seed a real blob by driving a pairing to `open` (which calls saveCreds).
    const sock = fakeSocket();
    const { factory, configs } = recordingFactory(sock);
    const vault = memoryVault();
    const h = new WhatsAppWebHandler({ granted: GRANTED, socketFactory: factory });
    const session = h.startPairing({ vault });
    const updatesPromise = collect(session.updates());
    await waitFor(() => configs.length > 0);
    sock.emit("connection.update", { connection: "open" });
    await updatesPromise;
    expect(vault.store.has(KEY)).toBe(true);

    // A fresh handler authenticates from that persisted blob.
    const h2 = new WhatsAppWebHandler({ granted: GRANTED });
    await h2.authenticate(vault);
  });
});

describe("WhatsAppWebHandler — receive + send", () => {
  test("receive feeds a non-fromMe text message into the sink; fromMe is ignored", async () => {
    const recvSock = fakeSocket();
    const { factory } = recordingFactory(recvSock);
    const vault = memoryVault({ [KEY]: '{"creds":{},"keys":{}}' });
    const h = new WhatsAppWebHandler({ granted: GRANTED, socketFactory: factory });
    await h.authenticate(vault);

    const got: InboundMessage[] = [];
    const handle = h.receive(async (m) => {
      got.push(m);
    });

    recvSock.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { remoteJid: "123@s.whatsapp.net", fromMe: true },
          message: { conversation: "mine" },
        },
        {
          key: {
            remoteJid: "123@s.whatsapp.net",
            fromMe: false,
            participant: "456@s.whatsapp.net",
          },
          message: { conversation: "hello vesper" },
        },
      ],
    });

    await Promise.resolve();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      channel: "whatsapp-web",
      chatId: "123@s.whatsapp.net",
      from: "456@s.whatsapp.net",
      text: "hello vesper",
    });
    handle.stop();
    expect(recvSock.isEnded()).toBe(true);
  });

  test("receive reads extendedTextMessage text too", async () => {
    const recvSock = fakeSocket();
    const { factory } = recordingFactory(recvSock);
    const vault = memoryVault({ [KEY]: '{"creds":{},"keys":{}}' });
    const h = new WhatsAppWebHandler({ granted: GRANTED, socketFactory: factory });
    await h.authenticate(vault);

    const got: InboundMessage[] = [];
    h.receive(async (m) => {
      got.push(m);
    });
    recvSock.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { remoteJid: "9@s.whatsapp.net", fromMe: false },
          message: { extendedTextMessage: { text: "rich text" } },
        },
      ],
    });
    await Promise.resolve();
    expect(got[0]?.text).toBe("rich text");
    expect(got[0]?.from).toBe("9@s.whatsapp.net");
  });

  test("send throws when not connected", async () => {
    const h = new WhatsAppWebHandler({ granted: GRANTED });
    await expect(
      h.send({ kind: "reply", chatId: "123@s.whatsapp.net", text: "hi" }),
    ).rejects.toMatchObject({ reason: "send_failed" });
  });

  test("send delivers on the socket receive opened", async () => {
    const recvSock = fakeSocket();
    const { factory } = recordingFactory(recvSock);
    const vault = memoryVault({ [KEY]: '{"creds":{},"keys":{}}' });
    const h = new WhatsAppWebHandler({ granted: GRANTED, socketFactory: factory });
    await h.authenticate(vault);
    h.receive(async () => {});

    await h.send({ kind: "reply", chatId: "123@s.whatsapp.net", text: "pong" });
    expect(recvSock.sent).toEqual([{ jid: "123@s.whatsapp.net", text: "pong" }]);
  });
});
