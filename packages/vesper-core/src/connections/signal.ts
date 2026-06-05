/**
 * Signal channel handler — send-only v1 over the local `signal-cli` binary, with
 * self-driving device-link QR pairing. Modeled on the WhatsApp send-only handler
 * (a no-op `receive`) plus the whatsapp-web self-driving `Pairable`.
 *
 * Signal has no hosted API and no npm SDK; egress is a `signal-cli` subprocess (the
 * {@link SignalCli} seam), not an HTTP fetch — so the host-allowlist (`allowlistedFetch`)
 * does not apply to this `local-cli` transport, and `send` asserts `NETWORK_FETCH`
 * directly. Signal's session keys live in signal-cli's own encrypted data dir; Vesper's
 * vault holds only the linked account NUMBER (`signal_account`), persisted at pairing.
 */

import { assertCapabilities } from "../capabilities/assert.ts";
import type { Capability } from "../capabilities/index.ts";
import { channelById } from "./catalog.ts";
import { ConnectionError } from "./errors.ts";
import { PAIRING_TTL_MS } from "./pairing.ts";
import { makeSignalCli, type SignalCli } from "./signal-cli.ts";
import type {
  ChannelDescriptor,
  ChannelHandler,
  ChatSink,
  OutboundIntent,
  Pairable,
  PairingDeps,
  PairingSession,
  PairingUpdate,
  Stoppable,
} from "./types.ts";

const SIGNAL_DESCRIPTOR = channelById("signal") as ChannelDescriptor;

/** Construction options for {@link SignalHandler}. */
export interface SignalHandlerOptions {
  readonly granted: readonly Capability[];
  /** Vault KEY the linked account number is stored under (default `signal_account`). */
  readonly vaultKey?: string;
  /** The signal-cli process seam; defaults to the real binary. Injected in tests. */
  readonly cli?: SignalCli;
  /** Device name shown in the phone's Linked Devices list. */
  readonly deviceName?: string;
}

export class SignalHandler implements ChannelHandler, Pairable {
  readonly descriptor: ChannelDescriptor = SIGNAL_DESCRIPTOR;
  readonly #granted: readonly Capability[];
  readonly #vaultKey: string;
  readonly #cli: SignalCli;
  readonly #deviceName: string;
  #account: string | null = null;

  constructor(options: SignalHandlerOptions) {
    this.#granted = options.granted;
    this.#vaultKey = options.vaultKey ?? "signal_account";
    this.#cli = options.cli ?? makeSignalCli();
    this.#deviceName = options.deviceName ?? "Vesper";
  }

  /** Load the linked account number from the vault, then verify signal-cli + linking. */
  async authenticate(vault: { get(key: string): Promise<string> }): Promise<void> {
    const account = (await vault.get(this.#vaultKey)).trim();
    if (account.length === 0) {
      throw new ConnectionError("not_authenticated", "signal account is empty — pair Signal first");
    }
    await this.#cli.probe(account);
    this.#account = account;
  }

  /** Send a 1:1 text. `intent.chatId` is the recipient number (the own number = Note to Self). */
  async send(intent: OutboundIntent): Promise<void> {
    assertCapabilities(["NETWORK_FETCH"], this.#granted);
    if (this.#account === null) {
      throw new ConnectionError("not_authenticated", "signal handler is not authenticated");
    }
    await this.#cli.send(this.#account, intent.chatId, intent.text);
  }

  /** Inbound is not built in v1 (send-only, like WhatsApp). No-op {@link Stoppable}. */
  receive(_sink: ChatSink): Stoppable {
    return { stop() {} };
  }

  /**
   * Self-driving device-link pairing: spawn `signal-cli link`, stream the URI as a
   * QR prompt, persist the associated account number to the vault, and emit `linked`
   * carrying it (so the coordinator records it as the owner destination). The
   * coordinator dispatches this channel with `pairingNeedsInbound: false`, so it
   * skips the authenticate precondition and the transient inbound receiver.
   */
  startPairing(deps: PairingDeps): PairingSession {
    const session = this.#cli.link(this.#deviceName);
    const vault = deps.vault;
    const vaultKey = this.#vaultKey;
    const label = this.descriptor.displayName;
    let stopped = false;

    async function* updates(): AsyncGenerator<PairingUpdate> {
      let linked = false;
      try {
        for await (const event of session.events()) {
          if (stopped) return;
          if (event.kind === "uri") {
            yield {
              status: "awaiting",
              prompt: {
                kind: "code",
                data: event.uri,
                humanHint:
                  "Open Signal > Settings > Linked Devices > Link New Device, then scan this code.",
                expiresAt: Date.now() + PAIRING_TTL_MS,
              },
            };
            continue;
          }
          // event.kind === "linked": persist the account number FIRST, then mark
          // linked + signal success. Order matters: if the vault write throws,
          // `linked` stays false so the catch below surfaces the error (rather than
          // ending the stream with no terminal update).
          await vault.set(vaultKey, event.account);
          linked = true;
          yield { status: "linked", chatId: event.account, label };
          return;
        }
        // The stream ended without an association.
        yield stopped ? { status: "expired" } : { status: "error", reason: "link_incomplete" };
      } catch (error) {
        if (!linked) {
          yield {
            status: "error",
            reason: error instanceof Error ? error.message : "link_failed",
          };
        }
      }
    }

    return {
      updates,
      stop: () => {
        if (stopped) return;
        stopped = true;
        session.stop();
      },
    };
  }
}
