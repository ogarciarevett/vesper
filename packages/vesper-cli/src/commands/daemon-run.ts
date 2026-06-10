import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import {
  ApprovalTokenStore,
  BENCHMARK_SOURCE,
  CHANNEL_PLUGINS,
  type ChannelRegistry,
  channelStates,
  DEFAULT_AGENT_MATCHERS,
  DEFAULT_ELEVENLABS_VOICE_ID,
  DEFAULT_VOICE_SETTINGS,
  type DirectoryModel,
  detectAvailableCLIs,
  elevenLabsTts,
  fetchModelDirectory,
  HandlerRegistry,
  KeychainVault,
  openStore,
  Scheduler,
  selectModel,
  startIpcServer,
} from "@vesper/core";
import {
  ChangeDecisionCoordinator,
  type CustomPipelineDeps,
  grantedCapabilities,
  ORCHESTRATION_CONTRACTS,
  PIPELINES,
  pipelinePrompts,
  pipelineSummaries,
  registerCustomPipelines,
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
import { improveModelRows, makeCustomPipelinesSurface } from "../make-custom-pipelines.ts";
import { makeNotifyFn } from "../make-notify.ts";
import { makeSoftwareEngineerSurface } from "../make-software-engineer.ts";
import { loadOptionalChannels } from "../optional-channels.ts";
import { PairingCoordinator } from "../pairing-coordinator.ts";
import {
  dbPath,
  pidPath,
  pipelinesDir,
  runDir,
  skillTrainDir,
  socketPath,
  uiPort,
} from "../paths.ts";
import { syncPipelinesFolder } from "../pipelines-folder.ts";
import { SkillLibrary } from "../skill-library.ts";
import { dim, green, line, yellow } from "../ui.ts";
import { setToken as setChannelToken } from "./connections.ts";

/** Scheduler tick interval (1 minute). */
const TICK_INTERVAL_MS = 60_000;

/** How long one fetched model directory serves the picker before re-fetching. */
const MODEL_DIRECTORY_TTL_MS = 60 * 60 * 1_000;

/** Keychain key for the user's own ElevenLabs API key (voice settings). */
const ELEVENLABS_VAULT_KEY = "elevenlabs_api_key";

/**
 * Cached live-directory provider for `GET /api/models/directory`: at most one
 * OpenRouter fetch per TTL window (allowlisted host, no API key), concurrent
 * requests share the in-flight fetch, and failures propagate so the route can
 * answer `{ available: false }` — never a crashed daemon, never a stale error.
 */
function makeModelDirectoryProvider(): { list(): Promise<readonly DirectoryModel[]> } {
  let cached: { at: number; models: readonly DirectoryModel[] } | null = null;
  let inFlight: Promise<readonly DirectoryModel[]> | null = null;
  return {
    list(): Promise<readonly DirectoryModel[]> {
      if (cached !== null && Date.now() - cached.at < MODEL_DIRECTORY_TTL_MS) {
        return Promise.resolve(cached.models);
      }
      inFlight ??= fetchModelDirectory({ granted: ["NETWORK_FETCH"] })
        .then((models) => {
          cached = { at: Date.now(), models };
          return models;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}

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
    // The model the orchestrator's own brain calls will use — shared between the
    // router registration and `/api/status` (the titlebar pill): template pin >
    // benchmark frontier pick > configured default (undefined = the CLI's own default).
    const pickRouterOrchestratorModel = (): string | undefined => {
      const pinned = uiStore.getTemplate("router")?.defaultParams?.orchestratorModel;
      if (typeof pinned === "string" && pinned.trim().length > 0) return pinned.trim();
      return (
        selectModel(
          uiStore.getModelBenchmarks(BENCHMARK_SOURCE),
          {
            ...(config.models?.default !== undefined ? { default: config.models.default } : {}),
            catalog: effectiveCatalog(config),
          },
          "hard",
        )?.canonicalId ?? config.models?.default
      );
    };
    registerPipelines(scheduler, registry, {
      getDefaultParams: (handlerId) => uiStore.getTemplate(handlerId)?.defaultParams ?? {},
      softwareEngineerCoordinator: sweCoordinator,
      // Benchmark-driven model routing for plan tasks: pick from the persisted
      // DeepSWE snapshot + the effective catalog; undefined = no override.
      pickModel: (difficulty) =>
        selectModel(
          uiStore.getModelBenchmarks(BENCHMARK_SOURCE),
          {
            ...(config.models?.default !== undefined ? { default: config.models.default } : {}),
            catalog: effectiveCatalog(config),
          },
          difficulty,
        )?.canonicalId,
      // Orchestrator-by-default: the router's own brain calls run on the
      // template's pinned model, else the benchmark frontier pick, else the
      // configured default model (undefined = the CLI's own default).
      pickOrchestratorModel: pickRouterOrchestratorModel,
      // Launch spawnsOwnChildren plan tasks (software-engineer) as sibling
      // top-level runs grouped under the router run (display lineage only).
      runSibling: async (handlerId, options) =>
        scheduler.run(handlerId, {
          params: options.params,
          parentRunId: options.parentRunId,
          ...(options.model !== undefined ? { model: options.model } : {}),
        }),
      // Ground truth for the router's `answer` action: registered pipelines,
      // the last ten runs, and the schedule list — read live per chat turn.
      getRuntimeContext: () => ({
        pipelines: pipelineSummaries(),
        recentRuns: uiStore
          .listRuns({})
          .slice(-10)
          .map((r) => ({ pipeline: r.pipeline, status: r.status, summary: r.summary, ts: r.ts })),
        schedules: scheduler.list().map((t) => ({
          id: t.id,
          kind: t.kind,
          schedule_expr: t.schedule_expr,
          enabled: t.enabled,
        })),
      }),
    });

    // User-authored pipelines (specs/pipeline-editor.md): build the shared
    // interpreter deps, register every saved active doc as a `custom:<id>` manual
    // task, and expose the validate/save/archive/improve surface to the UI routes
    // (and through them to `vesper pipeline` — one code path, structural parity).
    // The skill library + memory provider are constructed below; the deps
    // late-bind them through getters read only at run time.
    let skillLibraryRef: SkillLibrary | undefined;
    let memoryRef: Awaited<ReturnType<typeof makeMemoryProvider>> | undefined;
    const modelsConfigForPicks = {
      ...(config.models?.default !== undefined ? { default: config.models.default } : {}),
      catalog: effectiveCatalog(config),
    };
    const customDeps: CustomPipelineDeps = {
      getDoc: (id) => {
        const row = uiStore.getCustomPipeline(id);
        return row !== null && row.status === "active" ? row.doc : null;
      },
      contracts: ORCHESTRATION_CONTRACTS,
      getSkillBody: async (name) => (await skillLibraryRef?.get(name))?.body ?? null,
      getDefaultParams: (handlerId) => uiStore.getTemplate(handlerId)?.defaultParams ?? {},
      pickOrchestratorModel: () =>
        selectModel(uiStore.getModelBenchmarks(BENCHMARK_SOURCE), modelsConfigForPicks, "hard")
          ?.canonicalId ?? config.models?.default,
      runSibling: async (handlerId, options) =>
        scheduler.run(handlerId, {
          params: options.params,
          parentRunId: options.parentRunId,
          ...(options.model !== undefined ? { model: options.model } : {}),
        }),
      searchMemory: async (query, k) =>
        (await memoryRef?.search(query, k).catch(() => []))?.map((h) => h.text) ?? [],
    };
    const customResults = registerCustomPipelines(
      scheduler,
      registry,
      uiStore.listCustomPipelines({ status: "active" }).map((r) => ({ id: r.id, doc: r.doc })),
      customDeps,
    );
    for (const result of customResults.filter((r) => !r.ok)) {
      line(yellow(`  custom pipeline "${result.id}" skipped: ${result.errors.join("; ")}`));
    }
    const customPipelines = makeCustomPipelinesSurface({
      store: uiStore,
      scheduler,
      registry,
      deps: customDeps,
      complete,
      modelRows: () =>
        improveModelRows(effectiveCatalog(config), uiStore.getModelBenchmarks(BENCHMARK_SOURCE)),
    });
    // The markdown drop folder: every *.md in ~/.vesper/pipelines IS a pipeline
    // (specs/markdown-pipelines.md). Swept once at boot; `vesper pipeline sync`
    // re-sweeps through the route below.
    await mkdir(pipelinesDir(), { recursive: true });
    const folderSync = await syncPipelinesFolder(pipelinesDir(), customPipelines);
    for (const failure of folderSync.errors) {
      line(yellow(`  pipeline file "${failure.file}" skipped: ${failure.errors.join("; ")}`));
    }
    if (folderSync.loaded.length > 0) {
      line(dim(`  pipelines folder: loaded ${folderSync.loaded.join(", ")}`));
    }

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

    // In-chat voice surface (specs/voice-conversation.md, cloud TTS slice): config
    // + key are read FRESH per call so a Settings save takes effect without a
    // daemon restart. The key lives in the keychain only; `tts` answers null
    // whenever ElevenLabs is not fully configured (the chat falls back to the
    // browser's local voice — never an error mid-conversation).
    const elevenLabsKey = (): Promise<string | null> =>
      vault.get(ELEVENLABS_VAULT_KEY).then(
        (v) => (v.length > 0 ? v : null),
        () => null,
      );
    const voiceSurface = {
      async tts(text: string): Promise<{ audio: Uint8Array; mime: string } | null> {
        const cfg = await loadConfig();
        const v = cfg.voice ?? DEFAULT_VOICE_SETTINGS;
        if (v.tts !== "elevenlabs") return null;
        const apiKey = await elevenLabsKey();
        if (apiKey === null) return null;
        return elevenLabsTts(text, {
          apiKey,
          ...(v.elevenLabsVoiceId !== undefined ? { voiceId: v.elevenLabsVoiceId } : {}),
          ...(v.elevenLabsModelId !== undefined ? { modelId: v.elevenLabsModelId } : {}),
          granted: ["NETWORK_FETCH"],
        });
      },
      async getConfig(): Promise<{ tts: string; voiceId: string; keyConfigured: boolean }> {
        const cfg = await loadConfig();
        const v = cfg.voice ?? DEFAULT_VOICE_SETTINGS;
        return {
          tts: v.tts,
          voiceId: v.elevenLabsVoiceId ?? DEFAULT_ELEVENLABS_VOICE_ID,
          keyConfigured: (await elevenLabsKey()) !== null,
        };
      },
      async setConfig(input: {
        tts?: string;
        voiceId?: string;
        apiKey?: string;
      }): Promise<{ keyConfigured: boolean }> {
        const apiKey = input.apiKey?.trim() ?? "";
        if (apiKey.length > 0) await vault.set(ELEVENLABS_VAULT_KEY, apiKey);
        const cfg = await loadConfig();
        const base = cfg.voice ?? DEFAULT_VOICE_SETTINGS;
        const voiceId = input.voiceId?.trim() ?? "";
        await saveConfig({
          ...cfg,
          voice: {
            ...base,
            ...(input.tts === "local" || input.tts === "elevenlabs" ? { tts: input.tts } : {}),
            ...(voiceId.length > 0 ? { elevenLabsVoiceId: voiceId } : {}),
          },
        });
        return { keyConfigured: (await elevenLabsKey()) !== null };
      },
    };
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
    skillLibraryRef = skillLibrary;
    // Semantic memory (RAG): status + search backed by the configured bring-your-own
    // embedder. With none configured it degrades to available:false (no crash, no probe).
    const memory = await makeMemoryProvider(config, vault, uiStore);
    memoryRef = memory;
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
      customPipelines,
      syncPipelinesFolder: () => syncPipelinesFolder(pipelinesDir(), customPipelines),
      // Read-only prompt catalog of the built-ins (the genuine handler prompts).
      getBuiltinPrompts: pipelinePrompts,
      modelsCatalog: {
        ...(config.models?.default !== undefined ? { default: config.models.default } : {}),
        catalog: effectiveCatalog(config),
      },
      modelDirectory: makeModelDirectoryProvider(),
      orchestratorModel: pickRouterOrchestratorModel,
      voice: voiceSurface,
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
