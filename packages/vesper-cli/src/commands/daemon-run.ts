import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import {
  ApprovalTokenStore,
  CHANNEL_PLUGINS,
  type ChannelRegistry,
  channelStates,
  DEFAULT_AGENT_MATCHERS,
  detectAvailableCLIs,
  HandlerRegistry,
  KeychainVault,
  openStore,
  Scheduler,
  startIpcServer,
} from "@vesper/core";
import {
  ChangeDecisionCoordinator,
  grantedCapabilities,
  PIPELINES,
  registerPipelines,
} from "@vesper/pipelines";
import { presenceDetectorFor, startUiServer } from "@vesper/ui";
import { machineFingerprint } from "../banner.ts";
import { ChannelSetupCoordinator } from "../channel-setup-coordinator.ts";
import { effectiveCatalog, makeAgenticCompleteFn, makeCompleteFn } from "../cli-resolver.ts";
import { loadConfig, saveConfig, type VesperConfig } from "../config.ts";
import { buildChannelRegistry, makeChannelSink } from "../connections-wiring.ts";
import { removePidFile, resolveDaemonState, writePidFile } from "../daemon-lifecycle.ts";
import type { Command } from "../dispatch.ts";
import { makeMemoryProvider } from "../embeddings.ts";
import { makeNotifyFn } from "../make-notify.ts";
import { makeSoftwareEngineerSurface } from "../make-software-engineer.ts";
import { loadOptionalChannels } from "../optional-channels.ts";
import { PairingCoordinator } from "../pairing-coordinator.ts";
import { dbPath, pidPath, runDir, skillTrainDir, socketPath, uiPort } from "../paths.ts";
import { SkillLibrary } from "../skill-library.ts";
import { dim, green, line, yellow } from "../ui.ts";
import { setToken as setChannelToken } from "./connections.ts";

/** Scheduler tick interval (1 minute). */
const TICK_INTERVAL_MS = 60_000;

/**
 * `vesper daemon run` — the foreground daemon process: IPC server + scheduler tick
 * loop + the Vesper World UI, in one runtime. `vesper daemon start` spawns this
 * detached; macOS launchd runs it directly. Blocks until SIGINT/SIGTERM.
 *
 * Single-instance: refuses to start if a live daemon already holds the PID file
 * (a stale pidfile from a crash is overwritten). Writes its PID on start and
 * appends `daemon_started` / `daemon_stopped` to the audit (`events`) log.
 */
export const daemonRunCommand: Command = {
  name: "run",
  summary: "Run the daemon in the foreground (IPC + scheduler + UI). Ctrl-C to stop.",
  usage: "vesper daemon run",
  async run() {
    await mkdir(runDir(), { recursive: true });

    // Single-instance guard: one daemon holds the socket + DB.
    const existing = resolveDaemonState(pidPath());
    if (existing.status === "running") {
      line(yellow(`daemon already running (PID ${existing.pid})`));
      return 0;
    }

    // Ensure the database schema is fully migrated before opening for the scheduler.
    openStore(dbPath()).close();
    const db = new Database(dbPath());

    const handle = startIpcServer({ socketPath: socketPath() });

    // Resolve the CLI seam from config + detected CLIs so pipeline handlers can
    // shell out via `ctx.complete` (the same bring-your-own-CLI path as `vesper hello`).
    const config = await loadConfig();
    const installed = await detectAvailableCLIs();
    const complete = makeCompleteFn(config, installed);

    // The UI store also serves the router's editable template default_params (#4)
    // and is the audit sink for `ctx.notify`; opened before the scheduler so the
    // notify resolver can be wired into the constructor.
    const uiStore = openStore(dbPath());

    // `ctx.notify` resolver: delivers a pipeline notification out a connected
    // channel. The channel registry is built further below (after the scheduler), so
    // the resolver late-binds it through a getter read only at notify time.
    let channelRegistry: ChannelRegistry | undefined;
    const notify = makeNotifyFn({ getRegistry: () => channelRegistry, config, store: uiStore });

    // Construct the Scheduler granting only the capabilities the built-in
    // pipelines actually declare (deny-by-default), with the CLI + notify resolvers,
    // then register the pipelines so their handlers + tasks are available to the tick loop.
    const registry = new HandlerRegistry();
    const scheduler = new Scheduler({
      db,
      registry,
      grants: grantedCapabilities(),
      complete,
      notify,
      redactSummaries: config.storage?.redactRunSummaries === true,
    });
    // The software-engineer pipeline's human-approval gate and the UI decision route
    // share ONE coordinator: the running cycle blocks on it; the route resolves it.
    const sweCoordinator = new ChangeDecisionCoordinator();
    registerPipelines(scheduler, registry, {
      getDefaultParams: (handlerId) => uiStore.getTemplate(handlerId)?.defaultParams ?? {},
      softwareEngineerCoordinator: sweCoordinator,
    });

    // Host the Vesper World UI in-process (one runtime): the UI reads this
    // scheduler + storage directly and gets live run events off its EventBus.
    // Agent-presence detection uses the built-in allowlist plus any matchers
    // the user added under `presence.matchers` in config; `presence.pollMs`
    // overrides the scan interval.
    const presenceMatchers = [...DEFAULT_AGENT_MATCHERS, ...(config.presence?.matchers ?? [])];
    // Out-of-band approval tokens for privileged config mutations (template edits).
    // In-memory + per-process: a daemon restart invalidates every outstanding code.
    const approvalTokens = new ApprovalTokenStore();

    // Connections: open the vault and build the messaging-channel registry from config.
    // Only channels that ship a handler AND are enabled AND have a stored credential
    // start; a bad token is isolated + audited, never blocking the others. Inbound
    // messages bridge to the chatbot's EXISTING run path (see makeChannelSink); the
    // loops start AFTER the UI (their POST target) is listening.
    const vault = new KeychainVault();
    // Register opt-in channel packages (e.g. WhatsApp-Web via Baileys) BEFORE building the
    // registry so a paired one starts, and so the pairing coordinator + UI report it available.
    const optionalChannels = await loadOptionalChannels();
    const channels = await buildChannelRegistry({
      connections: config.connections,
      vault,
      store: uiStore,
    });
    // Late-bind the live registry into the notify resolver (declared before the scheduler).
    channelRegistry = channels.registry;
    // Pairing (scan-to-connect): the coordinator multiplexes the daemon's single
    // inbound stream into active QR/link pairing sessions and persists the captured
    // chat id on link. Exposed to the UI's POST /api/connections/:id/pair route and
    // consumed by `vesper connections pair`.
    const pairing = new PairingCoordinator({
      registry: channels.registry,
      vault,
      load: () => loadConfig(),
      save: (next) => saveConfig(next),
      store: uiStore,
    });
    // Shared deps for vault-writing channel ops (manual token entry AND auto-onboarding),
    // so the UI, the CLI, and the setup coordinator all persist tokens identically.
    const channelDeps = {
      vault,
      load: () => loadConfig(),
      save: (next: VesperConfig) => saveConfig(next),
      plugins: CHANNEL_PLUGINS,
    };
    // Auto-onboarding: drive the user's CLI (agent-browser) to mint a token channel's
    // token, then persist it via the same `setToken` path. Backs POST /:id/setup +
    // `vesper connections setup`.
    const channelSetup = new ChannelSetupCoordinator({
      complete: makeAgenticCompleteFn(config, installed),
      persistToken: (id, token) => setChannelToken(channelDeps, id, token, {}),
      store: uiStore,
    });
    // Read-only skill library for the Skills section. Skills live in `.ai/skills` (the
    // repo's committed artifacts) + the per-developer skill-train state; absent dirs ->
    // an empty list (e.g. a daemon launched outside the repo).
    const skillLibrary = new SkillLibrary({ skillsDir: ".ai/skills", trainDir: skillTrainDir() });
    // Semantic memory (RAG): status + search backed by the configured bring-your-own
    // embedder. With none configured it degrades to available:false (no crash, no probe).
    const memory = await makeMemoryProvider(config, vault, uiStore);
    const ui = await startUiServer({
      scheduler,
      store: uiStore,
      seed: machineFingerprint(),
      port: uiPort(),
      version: "0.1.0",
      socketPath: socketPath(),
      defaultCli: config.cli.default ?? null,
      detectClis: async () => installed.map((name) => ({ name, status: "installed", ok: true })),
      detectPresences: presenceDetectorFor(presenceMatchers),
      approvalTokens,
      softwareEngineer: makeSoftwareEngineerSurface({
        coordinator: sweCoordinator,
        store: uiStore,
      }),
      connections: {
        // Reload config each call so a UI/CLI token-set (which writes to disk) is
        // reflected immediately — configured + enabled flip without a daemon restart.
        list: async () =>
          channelStates({
            wiring: (await loadConfig()).connections,
            storedKeys: await vault.list(),
            runningIds: channels.runningIds,
          }),
        // Reuse the exact CLI `connections set` path so UI + CLI write identically
        // (vault set + enable in config). The handler must restart to pick up a brand-new
        // channel, but the badge reflects the stored credential at once (storedKeys).
        setToken: (id, token, params) => setChannelToken(channelDeps, id, token, params ?? {}),
        // Auto-onboarding: "Connect" on a not-yet-configured token channel drives the CLI.
        setup: (id) => channelSetup.setup(id),
      },
      skills: skillLibrary,
      memory,
      modelsCatalog: {
        ...(config.models?.default !== undefined ? { default: config.models.default } : {}),
        catalog: effectiveCatalog(config),
      },
      pairing,
      ...(config.presence?.pollMs !== undefined ? { presencePollMs: config.presence.pollMs } : {}),
      ...(config.ui?.theme !== undefined ? { defaultTheme: config.ui.theme } : {}),
    });

    // The UI (the chat sink's POST target) is now listening — start the inbound loops.
    const channelStop = channels.registry.startAll(
      pairing.tap(makeChannelSink({ baseUrl: ui.url, registry: channels.registry })),
    );
    if (channels.runningIds.length > 0) {
      line(dim(`  channels:  ${channels.runningIds.join(", ")}`));
    }
    if (optionalChannels.length > 0) {
      line(dim(`  optional:  ${optionalChannels.join(", ")} (opt-in package loaded)`));
    }

    // Start the cron tick loop. The scheduler records per-task errors for any
    // task whose handler is not registered — pipelines are now loaded above.
    const tickInterval = setInterval(() => {
      void scheduler.tick().catch(() => {
        // tick() isolates per-task errors internally; if the outer promise ever
        // rejects it is an unexpected bug — swallow so the loop keeps running.
      });
    }, TICK_INTERVAL_MS);

    // Claim the PID file + audit the start now that everything is listening.
    writePidFile(pidPath(), process.pid);
    uiStore.appendEvent({
      source: "daemon",
      kind: "daemon_started",
      payload: { pid: process.pid, ui: ui.url },
    });

    line(green("vesper daemon listening"));
    line(dim(`  pid:       ${process.pid}`));
    line(dim(`  socket:    ${handle.socketPath}`));
    line(dim(`  scheduler: tick every ${TICK_INTERVAL_MS / 1_000}s`));
    line(dim(`  pipelines: ${PIPELINES.map((p) => p.handlerId).join(", ")}`));
    line(dim(`  ui:        ${ui.url}  (run \`vesper ui\` to open)`));

    let shuttingDown = false;
    const shutdown = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      clearInterval(tickInterval);
      try {
        uiStore.appendEvent({
          source: "daemon",
          kind: "daemon_stopped",
          payload: { pid: process.pid },
        });
      } catch {
        // best-effort audit; never block shutdown.
      }
      removePidFile(pidPath());
      sweCoordinator.stop();
      channelStop.stop();
      ui.stop();
      uiStore.close();
      db.close();
      handle.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    // Block forever; the listener keeps the event loop alive until a signal arrives.
    await new Promise<void>(() => {});
    return 0;
  },
};
