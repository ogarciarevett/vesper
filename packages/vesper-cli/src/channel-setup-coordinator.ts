/**
 * Daemon-side channel AUTO-ONBOARDING coordinator: "Vesper sets up the channel for you."
 *
 * For a token channel (Telegram/Discord), `setup(id)` streams a {@link SetupSession} that
 * drives the user's CLI in AGENTIC mode (its agent-browser skill creates the bot and reads
 * back the token — the brain stays the CLI, Hard rule 12; Vesper adds no browser dependency),
 * STRICTLY parses the token, and persists it via the SAME `setToken` path manual entry uses.
 *
 * It is best-effort by design: a login wall, an unparseable result, a timeout, or a CLI error
 * all resolve to a graceful `awaiting_user` step (the surface then shows the manual token
 * field) — never a dead-end. Every attempt is audited as channel + outcome ONLY; the minted
 * token never reaches a response, a log, or an audit row.
 */

import {
  channelById,
  channelSetupById,
  NEED_USER_LOGIN,
  recordConnectionEvent,
  SETUP_TIMEOUT_MS,
  type SetupSession,
  type SetupUpdate,
  type Store,
} from "@vesper/core";

/** The agentic CLI completion the coordinator drives (returns at least the final text). */
export type AgenticComplete = (
  prompt: string,
  opts: { readonly agentic: true; readonly timeoutMs: number },
) => Promise<{ readonly text: string }>;

/** Seams that make the coordinator unit-testable (no real CLI, no real vault). */
export interface ChannelSetupDeps {
  /** Drive the user's CLI agentically to mint the token (the agent-browser turn). */
  readonly complete: AgenticComplete;
  /** Persist the minted token (vault set + enable) — the exact path the UI/CLI use. */
  readonly persistToken: (id: string, token: string) => Promise<unknown>;
  /** Audit sink (the daemon store); omitted in unit tests. */
  readonly store?: Store;
  /** Override the agentic timeout (ms). Default {@link SETUP_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/**
 * Multiplexes channel auto-onboarding for the daemon. One instance is shared by the UI
 * `POST /api/connections/:id/setup` route and the `vesper connections setup` CLI.
 */
export class ChannelSetupCoordinator {
  readonly #deps: ChannelSetupDeps;

  constructor(deps: ChannelSetupDeps) {
    this.#deps = deps;
  }

  /** Begin auto-onboarding `id`. Returns a streamed session (lazy — work starts on iteration). */
  setup(id: string): SetupSession {
    const deps = this.#deps;
    const audit = (
      kind: "connection_setup_started" | "connection_setup_succeeded" | "connection_setup_failed",
      reason?: string,
    ): void => {
      if (deps.store !== undefined) {
        recordConnectionEvent(deps.store, kind, {
          channel: id,
          ...(reason !== undefined ? { reason } : {}),
        });
      }
    };

    let stopped = false;

    async function* updates(): AsyncGenerator<SetupUpdate> {
      const spec = channelSetupById(id);
      const descriptor = channelById(id);
      if (spec === undefined || descriptor === undefined) {
        yield { status: "error", reason: `"${id}" has no automated setup` };
        return;
      }
      const name = descriptor.displayName;
      audit("connection_setup_started");
      yield { status: "working", message: `Setting up ${name} in a browser for you…` };

      let text: string;
      try {
        const res = await deps.complete(spec.buildPrompt(name), {
          agentic: true,
          timeoutMs: deps.timeoutMs ?? SETUP_TIMEOUT_MS,
        });
        text = res.text;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        audit("connection_setup_failed", "complete_failed");
        yield {
          status: "awaiting_user",
          reason: `Automatic setup could not run (${reason}). Enter your ${name} token below.`,
        };
        return;
      }
      if (stopped) return;

      if (text.includes(NEED_USER_LOGIN)) {
        audit("connection_setup_failed", "need_user_login");
        yield {
          status: "awaiting_user",
          reason: `${name} needs you to sign in. Finish in the browser, then enter the token below.`,
        };
        return;
      }

      const token = spec.parseToken(text);
      if (token === null) {
        audit("connection_setup_failed", "no_token");
        yield {
          status: "awaiting_user",
          reason: `Could not read a ${name} token automatically. Enter it below.`,
        };
        return;
      }

      yield { status: "working", message: `Saving your ${name} token…` };
      try {
        await deps.persistToken(id, token);
      } catch (err) {
        audit("connection_setup_failed", "persist_failed");
        yield {
          status: "error",
          reason: err instanceof Error ? err.message : "could not save token",
        };
        return;
      }
      audit("connection_setup_succeeded");
      yield { status: "configured" };
    }

    return {
      updates: () => updates(),
      stop: () => {
        stopped = true;
      },
    };
  }
}
