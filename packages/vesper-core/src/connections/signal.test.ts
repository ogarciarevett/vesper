import { describe, expect, test } from "bun:test";
import { CapabilityError } from "../capabilities/errors.ts";
import type { Vault } from "../vault/types.ts";
import { ConnectionError } from "./errors.ts";
import { SignalHandler } from "./signal.ts";
import type { SignalCli, SignalLinkEvent, SignalLinkSession } from "./signal-cli.ts";
import type { PairingDeps, PairingUpdate } from "./types.ts";

const GRANTS = ["NETWORK_FETCH", "READ_VAULT"] as const;

interface SendCall {
  account: string;
  recipient: string;
  text: string;
}

function fakeCli(opts: {
  probe?: () => Promise<void>;
  linkEvents?: readonly SignalLinkEvent[];
  linkThrows?: boolean;
}): { cli: SignalCli; sends: SendCall[]; linkKilled: () => boolean } {
  const sends: SendCall[] = [];
  let linkKilled = false;
  const cli: SignalCli = {
    probe: opts.probe ?? (async () => {}),
    send: async (account, recipient, text) => {
      sends.push({ account, recipient, text });
    },
    link: (): SignalLinkSession => ({
      async *events() {
        if (opts.linkThrows) throw new Error("link blew up");
        for (const event of opts.linkEvents ?? []) yield event;
      },
      stop() {
        linkKilled = true;
      },
    }),
  };
  return { cli, sends, linkKilled: () => linkKilled };
}

/** A fake vault recording sets; get returns the seeded value (or empty). */
function fakeVault(seed: Record<string, string> = {}): {
  vault: Vault;
  store: Record<string, string>;
} {
  const store: Record<string, string> = { ...seed };
  const vault: Vault = {
    get: async (key) => store[key] ?? "",
    set: async (key, value) => {
      store[key] = value;
    },
    delete: async (key) => {
      delete store[key];
    },
    list: async () => Object.keys(store),
  };
  return { vault, store };
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

describe("SignalHandler.authenticate", () => {
  test("loads the account from the vault and probes signal-cli", async () => {
    let probed = "";
    const { cli, sends } = fakeCli({
      probe: async () => {
        probed = "called";
      },
    });
    const { vault } = fakeVault({ signal_account: "+15551234567" });
    const handler = new SignalHandler({ granted: GRANTS, cli });
    await handler.authenticate(vault);
    expect(probed).toBe("called");
    // Once authenticated, send routes to the loaded account.
    await handler.send({ kind: "notify", chatId: "+15559998888", text: "hi" });
    expect(sends[0]).toEqual({
      account: "+15551234567",
      recipient: "+15559998888",
      text: "hi",
    });
  });

  test("throws not_authenticated when the vault has no account", async () => {
    const { cli } = fakeCli({});
    const { vault } = fakeVault({});
    const handler = new SignalHandler({ granted: GRANTS, cli });
    await expect(handler.authenticate(vault)).rejects.toMatchObject({
      reason: "not_authenticated",
    });
  });

  test("propagates a not_installed probe failure", async () => {
    const { cli } = fakeCli({
      probe: async () => {
        throw new ConnectionError("not_installed", "no signal-cli");
      },
    });
    const { vault } = fakeVault({ signal_account: "+1" });
    const handler = new SignalHandler({ granted: GRANTS, cli });
    await expect(handler.authenticate(vault)).rejects.toMatchObject({ reason: "not_installed" });
  });
});

describe("SignalHandler.send", () => {
  test("throws CapabilityError when NETWORK_FETCH is not granted", async () => {
    const { cli } = fakeCli({});
    const handler = new SignalHandler({ granted: ["READ_VAULT"], cli });
    await expect(handler.send({ kind: "notify", chatId: "+1", text: "x" })).rejects.toBeInstanceOf(
      CapabilityError,
    );
  });

  test("throws not_authenticated before authenticate has run", async () => {
    const { cli } = fakeCli({});
    const handler = new SignalHandler({ granted: GRANTS, cli });
    await expect(handler.send({ kind: "notify", chatId: "+1", text: "x" })).rejects.toMatchObject({
      reason: "not_authenticated",
    });
  });
});

describe("SignalHandler.receive", () => {
  test("is a no-op Stoppable (send-only v1)", () => {
    const { cli } = fakeCli({});
    const handler = new SignalHandler({ granted: GRANTS, cli });
    const stop = handler.receive(async () => {});
    expect(() => stop.stop()).not.toThrow();
  });
});

describe("SignalHandler.startPairing", () => {
  function deps(vault: Vault): PairingDeps {
    return { vault };
  }

  test("streams the URI as a QR prompt, persists the account, and links", async () => {
    const { cli } = fakeCli({
      linkEvents: [
        { kind: "uri", uri: "sgnl://linkdevice?uuid=a&pub_key=b" },
        { kind: "linked", account: "+15557654321" },
      ],
    });
    const { vault, store } = fakeVault();
    const handler = new SignalHandler({ granted: GRANTS, cli });
    const updates: PairingUpdate[] = await collect(handler.startPairing(deps(vault)).updates());

    expect(updates[0]).toMatchObject({
      status: "awaiting",
      prompt: { kind: "code", data: "sgnl://linkdevice?uuid=a&pub_key=b" },
    });
    expect(updates[1]).toEqual({
      status: "linked",
      chatId: "+15557654321",
      label: "Signal",
    });
    // The linked account number is persisted to the vault for later authenticate.
    expect(store.signal_account).toBe("+15557654321");
  });

  test("emits link_incomplete when the stream ends without an association", async () => {
    const { cli } = fakeCli({ linkEvents: [{ kind: "uri", uri: "sgnl://linkdevice?x=1" }] });
    const { vault } = fakeVault();
    const handler = new SignalHandler({ granted: GRANTS, cli });
    const updates = await collect(handler.startPairing(deps(vault)).updates());
    expect(updates.at(-1)).toEqual({ status: "error", reason: "link_incomplete" });
  });

  test("surfaces an error when the link process fails", async () => {
    const { cli } = fakeCli({ linkThrows: true });
    const { vault } = fakeVault();
    const handler = new SignalHandler({ granted: GRANTS, cli });
    const updates = await collect(handler.startPairing(deps(vault)).updates());
    expect(updates).toEqual([{ status: "error", reason: "link blew up" }]);
  });

  test("surfaces an error (not a silent end) when persisting the account fails", async () => {
    const { cli } = fakeCli({ linkEvents: [{ kind: "linked", account: "+15551234567" }] });
    const vault: Vault = {
      get: async () => "",
      set: async () => {
        throw new Error("keychain locked");
      },
      delete: async () => {},
      list: async () => [],
    };
    const handler = new SignalHandler({ granted: GRANTS, cli });
    const updates = await collect(handler.startPairing(deps(vault)).updates());
    expect(updates).toEqual([{ status: "error", reason: "keychain locked" }]);
  });

  test("stop() kills the underlying link session", async () => {
    const { cli, linkKilled } = fakeCli({ linkEvents: [] });
    const { vault } = fakeVault();
    const handler = new SignalHandler({ granted: GRANTS, cli });
    const session = handler.startPairing(deps(vault));
    session.stop();
    expect(linkKilled()).toBe(true);
    // Idempotent.
    expect(() => session.stop()).not.toThrow();
  });
});
