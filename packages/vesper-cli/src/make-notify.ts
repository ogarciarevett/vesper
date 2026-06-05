/**
 * Host-side resolver for `ctx.notify` (the pipeline-facing proactive-notification
 * seam). The scheduler core exposes `ctx.notify(text)` but stays decoupled from the
 * connections feature layer; this factory closes the gap: it resolves WHICH channel
 * and WHICH destination a notification goes to, then delivers it through the daemon's
 * already-authenticated running handler — no re-auth, no second socket.
 *
 * Destination resolution mirrors the spec: an explicit `intent.channel` wins, then
 * `config.notify.defaultChannel`, then the first running channel that has a paired
 * owner (`config.connections.<id>.params.defaultChatId`, persisted at pairing). The
 * owner chat id comes from that same pairing-captured `defaultChatId`, so a pipeline
 * never handles a chat id. Every actual send attempt is audited on the `events`
 * table (`notification_sent` / `notification_failed`); the body/chat id never land in
 * the audit payload (the connections audit helper strips them).
 */

import {
  type ChannelRegistry,
  type NotifyFn,
  type NotifyIntent,
  type NotifyOutcome,
  recordConnectionEvent,
  type Store,
} from "@vesper/core";
import type { VesperConfig } from "./config.ts";

/** Dependencies for {@link makeNotifyFn}. */
export interface MakeNotifyFnOpts {
  /**
   * Late-bound getter for the daemon's live channel registry. A getter (not the
   * registry itself) because the daemon constructs the scheduler BEFORE it builds
   * the registry; the getter is read at notify time, by which point it is set.
   */
  readonly getRegistry: () => ChannelRegistry | undefined;
  /** Non-secret wiring: `notify.defaultChannel` + per-channel `params.defaultChatId`. */
  readonly config: VesperConfig;
  /** Audit sink (the daemon store). Omitted in unit tests that do not assert audit. */
  readonly store?: Store;
}

/**
 * Resolve which channel a notify delivers through. An explicit request wins (only
 * if it is actually running); then a configured `defaultChannel` (if running); else
 * the first running channel that has a paired owner destination. Returns undefined
 * when nothing is eligible.
 */
function resolveChannel(
  requested: string | undefined,
  config: VesperConfig,
  registry: ChannelRegistry,
): string | undefined {
  const running = new Set<string>(registry.list().map((h) => h.descriptor.id));
  if (requested !== undefined) return running.has(requested) ? requested : undefined;
  const preferred = config.notify?.defaultChannel;
  if (preferred !== undefined && running.has(preferred)) return preferred;
  for (const handler of registry.list()) {
    const id = handler.descriptor.id;
    if (config.connections?.[id]?.params?.defaultChatId !== undefined) return id;
  }
  return undefined;
}

/** Build the {@link NotifyFn} injected into the daemon's {@link import("@vesper/core").Scheduler}. */
export function makeNotifyFn(opts: MakeNotifyFnOpts): NotifyFn {
  return async (intent: NotifyIntent): Promise<NotifyOutcome> => {
    const registry = opts.getRegistry();
    if (registry === undefined) return { delivered: false, reason: "no_channel" };

    const channel = resolveChannel(intent.channel, opts.config, registry);
    if (channel === undefined) return { delivered: false, reason: "no_channel" };

    const chatId = intent.chatId ?? opts.config.connections?.[channel]?.params?.defaultChatId;
    if (chatId === undefined) return { delivered: false, channel, reason: "no_destination" };

    const handler = registry.list().find((h) => h.descriptor.id === channel);
    if (handler === undefined) return { delivered: false, channel, reason: "no_channel" };

    try {
      await handler.send({ kind: "notify", chatId, text: intent.text });
    } catch {
      if (opts.store !== undefined) {
        recordConnectionEvent(opts.store, "notification_failed", {
          channel,
          reason: "send_failed",
        });
      }
      return { delivered: false, channel, reason: "send_failed" };
    }
    if (opts.store !== undefined) {
      recordConnectionEvent(opts.store, "notification_sent", { channel });
    }
    return { delivered: true, channel };
  };
}
