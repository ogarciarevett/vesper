import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ApprovalTokenStore,
  ChannelState,
  DirectoryModel,
  ModelCatalogEntry,
  PairingSession,
  RagHit,
  RagStatus,
  RunOutcome,
  RunTreeNode,
  Scheduler,
  SetupSession,
  Store,
} from "@vesper/core";
import {
  ApprovalError,
  BENCHMARK_SOURCE,
  encodeQr,
  RUN_COMPLETED,
  RUN_EVENT,
  ragStatus,
  SchedulerError,
  StorageError,
} from "@vesper/core";
import { ModuleRegistry } from "../modules/registry.ts";
import type { UiModule } from "../modules/types.ts";
import type {
  PresenceInfo,
  RunEventInfo,
  RunTreeInfo,
  SkillDetail,
  SkillSummary,
  SweDiffView,
} from "../world/types.ts";
import { defaultPresenceDetector, type PresenceDetector } from "./presence.ts";

/** A helper-CLI's detected status for the `/api/status` route + titlebar pill. */
interface CliStatusRow {
  readonly name: string;
  readonly status: string;
  readonly ok: boolean;
}

const CLIENT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "client");

/**
 * Prebuilt browser-client assets — the `index.html` shell and the bundled `app.js`.
 * Supplied when the daemon runs as a `bun build --compile` binary, where the client
 * source files and the runtime bundler are unavailable (the embedded FS has no
 * `client/` dir). See {@link setEmbeddedClientAssets}.
 */
export interface ClientAssets {
  readonly indexHtml: string;
  readonly appJs: string;
}

/**
 * Process-wide fallback client assets, set once by a compiled entrypoint before the
 * daemon starts. `startUiServer` prefers an explicit `deps.clientAssets`, then this,
 * then a from-disk build (the dev path) — so the compiled sidecar can embed the UI
 * without threading assets through every daemon caller.
 */
let embeddedClientAssets: ClientAssets | null = null;

/** Install process-wide {@link ClientAssets} (used by the compiled daemon sidecar). */
export function setEmbeddedClientAssets(assets: ClientAssets): void {
  embeddedClientAssets = assets;
}

/** One user-authored pipeline at a glance (`GET /api/pipelines/custom`). */
export interface CustomPipelineSummary {
  readonly id: string;
  readonly name: string;
  readonly revision: number;
  readonly tsUpdated: number;
  /** Derived from the doc — never user-picked. */
  readonly capabilities: readonly string[];
}

/** One user-authored pipeline in full (`GET /api/pipelines/custom/:id`). */
export interface CustomPipelineDetail extends CustomPipelineSummary {
  /** The raw PipelineDoc as saved (the editor round-trips it). */
  readonly doc: Record<string, unknown>;
}

/** Outcome of a save/validate: derived capabilities, or every validation error. */
export interface SaveCustomPipelineOutcome {
  readonly ok: boolean;
  readonly capabilities: readonly string[];
  readonly errors: readonly string[];
}

/** The "Improve with AI" proposal — NEVER auto-applied; the human accepts per field. */
export interface CustomPipelineImproveProposal {
  readonly steps: readonly {
    readonly id: string;
    readonly prompt?: string;
    readonly cli?: string;
    readonly model?: string;
    readonly reason: string;
  }[];
  readonly orchestratorModel?: string;
  readonly warnings: readonly string[];
  readonly notes: string;
}

/**
 * The custom-pipelines surface the daemon wires (validate/persist/register/improve
 * in one place — see vesper-cli's makeCustomPipelinesSurface). The routes here and,
 * through them, the `vesper pipeline` CLI both consume THIS, so UI/CLI parity is
 * structural.
 */
/** One invocable pipeline target the editor may reference in a `pipeline` step. */
export interface CustomPipelineTarget {
  readonly handlerId: string;
  readonly summary: string;
  readonly paramKeys: readonly string[];
  readonly promptParam: string;
  readonly acceptsModel: boolean;
}

export interface CustomPipelinesSurface {
  list(): CustomPipelineSummary[];
  get(id: string): CustomPipelineDetail | null;
  /** The orchestration-contract targets a doc's `pipeline` steps may name. */
  targets(): readonly CustomPipelineTarget[];
  /** Validate WITHOUT persisting (the editor's live check + `save --validate`). */
  validate(doc: Record<string, unknown>): SaveCustomPipelineOutcome;
  save(id: string, doc: Record<string, unknown>): SaveCustomPipelineOutcome;
  archive(id: string): boolean;
  improve(id: string, scope?: string): Promise<CustomPipelineImproveProposal | null>;
  /** Markdown form (specs/markdown-pipelines.md): parse a .md source to a raw doc. */
  parseMarkdown(source: string): SaveCustomPipelineOutcome & {
    readonly doc?: Record<string, unknown>;
  };
  /** Serialize a doc to its markdown form (null when the doc is invalid). */
  serializeMarkdown(doc: Record<string, unknown>): string | null;
}

/** Dependencies for {@link startUiServer}. */
export interface UiServerDeps {
  readonly scheduler: Scheduler;
  readonly store: Store;
  /** Stable per-machine seed (fingerprint). Retained for callers; unused since the
   * pixel-art world was retired. */
  readonly seed?: string;
  /** Daemon version for the `/api/status` route + titlebar pill (default "0.1.0"). */
  readonly version?: string;
  /** IPC socket path shown in the Runtime panel. */
  readonly socketPath?: string;
  /** Configured default helper-CLI name (from config). */
  readonly defaultCli?: string | null;
  /** Cheap CLI presence probe for `/api/status` (which-based; no auth probe). */
  readonly detectClis?: () => Promise<readonly CliStatusRow[]>;
  readonly port?: number;
  readonly hostname?: string;
  /** Optional pluggable UI modules (e.g. Voice). MVP passes none. */
  readonly modules?: readonly UiModule[];
  /** Detects agents running on this machine. Defaults to the real `ps` scanner. */
  readonly detectPresences?: PresenceDetector;
  /** Min interval (ms) between on-demand presence scans for `/api/presence` (cache TTL). Default 3000. */
  readonly presencePollMs?: number;
  /** Default Vesper World theme id, stamped into the page for the client to read. */
  readonly defaultTheme?: string;
  /**
   * Out-of-band approval-token store. Privileged config mutations
   * (`PUT /api/pipelines/:id/template`) require a valid single-use code from this
   * store IN ADDITION to {@link isLocalRequest}. When omitted, those mutations are
   * refused (403) — fail-closed; the chatbot/template surface is then read-only.
   */
  readonly approvalTokens?: ApprovalTokenStore;
  /**
   * Connections (messaging channels) surface. `list` resolves each catalog channel's
   * live state (available / configured / enabled / running) for `GET /api/connections`.
   * Absent -> the route returns an empty list (the daemon wired no channel provider).
   */
  readonly connections?: {
    list(): Promise<readonly ChannelState[]>;
    /**
     * Store a channel credential entered in the UI (vault `set` + enable in config),
     * reusing the exact CLI `connections set` path so both surfaces write identically.
     * Backs `POST /api/connections/:id/token`. Absent -> that route is fail-closed (503).
     * The token NEVER appears in a response, an audit row, or a log. Local-origin only
     * (no approval code) by design — setting a token is accepted for the single-user
     * local runtime (see specs/channel-auto-onboarding.md, Slice 0).
     */
    setToken?(
      id: string,
      token: string,
      params?: Readonly<Record<string, string>>,
    ): Promise<{ vaultKey: string }>;
    /**
     * Begin AUTO-ONBOARDING a token channel: drive the user's CLI (agent-browser) to
     * mint the token, persist it, and stream {@link SetupSession} progress. Backs
     * `POST /api/connections/:id/setup`. Absent -> that route is 503. The minted token
     * never appears in the stream — only progress + a terminal status.
     */
    setup?(id: string): SetupSession;
  };
  /**
   * Pairing (scan-to-connect) provider. `startPairing` begins a QR/link pairing
   * attempt for one channel and returns a streamed {@link PairingSession}; the
   * `POST /api/connections/:id/pair` route relays its updates as ndjson. Absent ->
   * the route returns 503 (the daemon wired no pairing coordinator).
   */
  readonly pairing?: {
    startPairing(channelId: string): Promise<PairingSession>;
  };
  /**
   * Skills library (read-only). `list` returns every skill's at-a-glance summary for
   * `GET /api/skills`; `get` returns one skill's full detail (committed body, trained
   * candidate, tasks, history) for `GET /api/skills/:name`. Skills are shared across
   * pipelines + Vesper, so this is a plain read surface — training/accept/revert stay on
   * the cost-gated `vesper skill` CLI. Absent -> the routes return [] / 404.
   */
  readonly skills?: {
    list(): Promise<readonly SkillSummary[]>;
    get(name: string): Promise<SkillDetail | null>;
  };
  /**
   * Model catalog handed through for `GET /api/models` (the effective merged
   * catalog + configured default). Absent -> the route serves benchmarks with an
   * empty catalog.
   */
  readonly modelsCatalog?: {
    readonly default?: string;
    readonly catalog: Readonly<Record<string, ModelCatalogEntry>>;
  };
  /**
   * Live model directory for `GET /api/models/directory` (the picker's
   * provider-grouped list). The daemon wires a cached OpenRouter fetch
   * (allowlisted, no API key); the route NEVER throws — a failed fetch serves
   * `{ available: false, models: [] }` so the picker degrades to the catalog.
   */
  readonly modelDirectory?: {
    list(): Promise<readonly DirectoryModel[]>;
  };
  /**
   * The model the orchestrator's own brain calls will use (router template pin
   * > benchmark frontier pick > configured default). Surfaced on `/api/status`
   * for the titlebar pill; absent/undefined hides the pill.
   */
  readonly orchestratorModel?: () => string | undefined;
  /**
   * Voice surface for the in-chat voice (specs/voice-conversation.md, cloud TTS
   * slice). `tts` returns null when cloud TTS is not configured — the client
   * then falls back to the browser's local voice. `setConfig` persists the
   * provider/voice id to config and the API key to the OS keychain; the key is
   * never echoed back (`keyConfigured` only). Routes degrade when absent.
   */
  readonly voice?: {
    tts(text: string): Promise<{ audio: Uint8Array; mime: string } | null>;
    getConfig(): Promise<{ tts: string; voiceId: string; keyConfigured: boolean }>;
    setConfig(input: {
      tts?: string;
      voiceId?: string;
      apiKey?: string;
    }): Promise<{ keyConfigured: boolean }>;
  };
  /**
   * Semantic-memory (RAG) surface. `status` returns the live {@link RagStatus} (never
   * throws — degrades to unavailable when no embedder is configured); `search` runs the
   * `ragSearch` seam and may throw `StorageError("rag_unavailable")` when disabled (the
   * route catches it and reports `available:false`). Absent -> `/api/memory` reports the
   * scaffold's count-only unavailable status and `/api/memory/search` returns no hits.
   */
  readonly memory?: {
    status(): Promise<RagStatus>;
    search(query: string, k: number): Promise<readonly RagHit[]>;
  };
  /**
   * Software-engineer pipeline surface. `loadDiff` returns the structured per-file
   * diff for a run's proposed change (read-only, rendered GitHub-PR style); `decide`
   * delivers a human approve/reject to the blocked cycle via the shared decision
   * coordinator and returns whether a waiter was actually unblocked. Absent -> the
   * `/diff` + `/decision` routes return 503 (the daemon wired no provider).
   */
  /**
   * User-authored pipelines (specs/pipeline-editor.md). Backs the
   * `/api/pipelines/custom*` routes; absent -> those routes return 503 (the
   * daemon wired no provider). Mutations additionally require the single-use
   * approval code (same flow as template edits).
   */
  readonly customPipelines?: CustomPipelinesSurface;
  /**
   * Re-sweep the markdown pipelines drop folder (`~/.vesper/pipelines/*.md`) and
   * upsert changed files. Backs `POST /api/pipelines/custom/sync` (and through it
   * `vesper pipeline sync`). Absent -> that route is 503.
   */
  readonly syncPipelinesFolder?: () => Promise<{
    readonly loaded: readonly string[];
    readonly unchanged: readonly string[];
    readonly errors: readonly { readonly file: string; readonly errors: readonly string[] }[];
  }>;
  /**
   * Read-only prompt catalog of a BUILT-IN pipeline (the genuine prompt templates
   * its handler sends, with `{{...}}` markers for the dynamic parts). The daemon
   * wires this to `@vesper/pipelines`' `pipelinePrompts`; absent -> the template
   * route reports an empty catalog. Display-only — never an editable surface.
   */
  readonly getBuiltinPrompts?: (
    handlerId: string,
  ) => readonly { readonly name: string; readonly template: string }[];
  readonly softwareEngineer?: {
    loadDiff(
      runId: string,
      opts: { readonly changeId?: string; readonly staged?: boolean },
    ): Promise<SweDiffView | null>;
    decide(
      runId: string,
      changeId: string,
      decision: { readonly decision: "approve" | "reject"; readonly reason?: string },
    ): boolean;
  };
  /**
   * Prebuilt client assets. When set, the server serves these instead of reading
   * `client/index.html` and bundling `client/main.ts` from disk — required for the
   * compiled (`bun build --compile`) daemon. Falls back to {@link setEmbeddedClientAssets},
   * then to an on-disk build.
   */
  readonly clientAssets?: ClientAssets;
}

/** A running UI server. */
export interface UiServerHandle {
  readonly port: number;
  readonly url: string;
  stop(): void;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Local hostnames the server accepts (single-user local runtime). */
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * RFC-4122 UUID shape. Run ids are server-allocated UUIDs (`store.startRun` ->
 * `crypto.randomUUID`); the trace routes + WS subscribe topic accept ONLY this
 * shape so a client cannot craft a wildcard/path-traversal topic to subscribe to.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The wire shape of a `RUN_EVENT` bus payload (see scheduler `emitProgress`). */
interface RunEventPayload {
  /** Persisted `run_events` row id — matches the backfilled {@link RunEventInfo}.id so a live frame de-dupes against its replayed twin. */
  readonly id: string;
  readonly runId: string;
  readonly parentRunId: string | null;
  /** Unix ms the event was emitted. */
  readonly ts: number;
  readonly kind: string;
  readonly message: string;
  readonly data?: Record<string, unknown>;
}

/** Narrow an `unknown` to a plain record (for optional event `data`). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Map a core `RunTreeNode` into the thin UI-facing {@link RunTreeInfo} (recursive). */
function mapTreeToInfo(node: RunTreeNode): RunTreeInfo {
  return {
    run: {
      id: node.run.id,
      pipeline: node.run.pipeline,
      status: node.run.status,
      summary: node.run.summary,
      ts: node.run.ts,
      parentRunId: node.run.parentRunId,
      context: node.run.context ?? null,
      cli: node.run.cli ?? null,
    },
    children: node.children.map(mapTreeToInfo),
  };
}

/** A chat-turn frame published to the `chat:<sessionId>` WS topic. */
interface ChatTurnFrame {
  readonly turnId: string;
  readonly runId: string | null;
  readonly role: "user" | "assistant";
  readonly text: string;
}

/** Publish a chat turn to its session's topic so live transcript views update. */
function publishChatTurn(
  server: { publish(topic: string, data: string): unknown },
  sessionId: string,
  frame: ChatTurnFrame,
): void {
  server.publish(`chat:${sessionId}`, JSON.stringify({ type: "chat:turn", ...frame }));
}

/** The editable-config view of a `ScheduledTask` returned by the template routes. */
interface PipelineConfig {
  readonly id: string;
  readonly handlerId: string;
  readonly kind: string;
  readonly scheduleExpr: string;
  readonly enabled: boolean;
  readonly maxRunsPerDay: number | null;
  readonly maxConcurrent: number | null;
  readonly maxDurationMs: number | null;
  readonly requiredCapabilities: readonly string[];
}

/** Map a core `ScheduledTask` to the thin {@link PipelineConfig} view (no secrets). */
function toPipelineConfig(task: {
  id: string;
  handler_id: string;
  kind: string;
  schedule_expr: string;
  enabled: boolean;
  max_runs_per_day: number | null;
  max_concurrent: number | null;
  max_duration_ms: number | null;
  required_capabilities: readonly string[];
}): PipelineConfig {
  return {
    id: task.id,
    handlerId: task.handler_id,
    kind: task.kind,
    scheduleExpr: task.schedule_expr,
    enabled: task.enabled,
    maxRunsPerDay: task.max_runs_per_day,
    maxConcurrent: task.max_concurrent,
    maxDurationMs: task.max_duration_ms,
    requiredCapabilities: [...task.required_capabilities],
  };
}

/** Parse a request's JSON body, returning a record or null (malformed/non-object). */
async function readJsonBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await req.json();
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Gate a privileged mutation behind a single-use approval code. Returns null when the
 * caller is authorised; otherwise a 403/401 `Response`. The code is read from the
 * `x-vesper-approval` header (out-of-band — minted by the daemon, never in the page).
 * When no token store is configured the route is fail-closed (403).
 */
function requireApproval(req: Request, tokens: ApprovalTokenStore | undefined): Response | null {
  if (tokens === undefined) {
    return json({ error: "approval is not configured (mutation refused)" }, 403);
  }
  const code = req.headers.get("x-vesper-approval");
  if (code === null || code.length === 0) {
    return json({ error: "approval code required" }, 401);
  }
  try {
    tokens.verify(code);
    return null;
  } catch (err) {
    if (err instanceof ApprovalError) {
      return json({ error: `approval ${err.reason}` }, 403);
    }
    return json({ error: "approval failed" }, 403);
  }
}

/** Extract the host (no port) from a `Host` header value or an `Origin` URL. */
function hostOf(value: string | null): string | null {
  if (value === null || value.length === 0) return null;
  try {
    if (value.includes("://")) return new URL(value).hostname;
    if (value.startsWith("[")) return value.slice(0, value.indexOf("]") + 1); // [::1]:port
    return value.split(":")[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Reject requests that aren't local-origin: blocks CSRF from a malicious website
 * (cross-origin POST `/run`) and DNS-rebinding (a rebound `Host`). A request with
 * no `Origin` (direct navigation, curl) and a local `Host` is allowed.
 */
function isLocalRequest(req: Request): boolean {
  const host = hostOf(req.headers.get("host"));
  if (host !== null && !LOCAL_HOSTS.has(host)) return false;
  const origin = req.headers.get("origin");
  if (origin !== null) {
    const oh = hostOf(origin);
    if (oh === null || !LOCAL_HOSTS.has(oh)) return false;
  }
  return true;
}

/** Build the browser client bundle once (Bun bundles `client/main.ts`). */
async function buildClientBundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(CLIENT_DIR, "main.ts")],
    target: "browser",
    minify: false,
  });
  if (!built.success) {
    throw new Error(`UI client build failed: ${built.logs.map((l) => String(l)).join("; ")}`);
  }
  const out = built.outputs[0];
  if (out === undefined) throw new Error("UI client build produced no output");
  return await out.text();
}

/**
 * Build the raw client assets from disk — the `index.html` shell and the bundled
 * `app.js`, without theme stamping. Used by the dev path and by the desktop build
 * step that embeds these into the compiled daemon; theme stamping happens later,
 * per-process, in {@link startUiServer}.
 */
export async function buildClientAssets(): Promise<ClientAssets> {
  const indexHtml = await Bun.file(join(CLIENT_DIR, "index.html")).text();
  const appJs = await buildClientBundle();
  return { indexHtml, appJs };
}

/** Resolve client assets: explicit dep, then process-embedded, then an on-disk build. */
async function resolveClientAssets(deps: UiServerDeps): Promise<ClientAssets> {
  if (deps.clientAssets !== undefined) return deps.clientAssets;
  if (embeddedClientAssets !== null) return embeddedClientAssets;
  return await buildClientAssets();
}

/**
 * Start the local Vesper World UI server (HTTP + WebSocket) on `127.0.0.1`.
 *
 * Routes: `GET /` (client shell), `GET /app.js` (bundled client), `GET /api/status`
 * + `GET /api/presence` (Diagnostics), `POST /api/pipelines/:id/run`
 * (run a pipeline -> {@link RunOutcome}), `GET /api/runs/:runId/events?afterTs=`
 * (replay a run's persisted live trace), `GET /api/runs/:runId/tree` (the run +
 * sub-agent hierarchy), and `WS /api/live` (pushes `run:completed` +
 * `run:event:lite`; a `{type:'subscribe'|'unsubscribe', runId}` frame joins/leaves a
 * single run's `run:event` stream).
 *
 * Bound to localhost only — single-user local runtime, no auth. The trace routes and
 * the WS subscribe topic both require a UUID-shaped `runId` and sit behind the same
 * local-origin guard as every other route.
 */
export async function startUiServer(deps: UiServerDeps): Promise<UiServerHandle> {
  const { scheduler, store } = deps;
  const startedAt = Date.now();
  const hostname = deps.hostname ?? "127.0.0.1";
  const port = deps.port ?? 4317;
  const modules = new ModuleRegistry(deps.modules ?? []);

  const assets = await resolveClientAssets(deps);
  // Stamp the configured default theme into the page (sanitized to [a-z0-9-]) so the
  // client can read it via <meta name="vesper-theme">. Shell templating only.
  const themeId = (deps.defaultTheme ?? "").replace(/[^a-z0-9-]/gi, "");
  const indexHtml =
    themeId.length > 0
      ? assets.indexHtml.replace(
          "</head>",
          `    <meta name="vesper-theme" content="${themeId}" />\n  </head>`,
        )
      : assets.indexHtml;
  const appJs = assets.appJs;

  // Live presence: the agents running on this machine right now. Detected ON DEMAND
  // for the Diagnostics view (GET /api/presence) only — the home no longer renders
  // presence, so there is no background poll. A short cache (presencePollMs) bounds
  // how often a burst of requests re-scans the process table.
  const detect = deps.detectPresences ?? defaultPresenceDetector();
  const presenceTtlMs = deps.presencePollMs ?? 3_000;
  let presenceCache: { at: number; value: PresenceInfo[] } | null = null;
  const presenceNow = async (): Promise<PresenceInfo[]> => {
    const now = Date.now();
    if (presenceCache === null || now - presenceCache.at >= presenceTtlMs) {
      presenceCache = { at: now, value: await detect() };
    }
    return presenceCache.value;
  };

  const server = Bun.serve({
    port,
    hostname,
    async fetch(req, srv) {
      // Local-origin guard: blocks cross-site CSRF on /run + DNS-rebinding reads.
      if (!isLocalRequest(req)) return new Response("forbidden", { status: 403 });

      const url = new URL(req.url);
      const { pathname } = url;

      // WebSocket upgrade for the live channel.
      if (pathname === "/api/live") {
        return srv.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
      }

      if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        return new Response(indexHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (req.method === "GET" && pathname === "/app.js") {
        return new Response(appJs, {
          headers: { "content-type": "text/javascript; charset=utf-8" },
        });
      }
      // GET /api/status — the Runtime panel + titlebar status pills.
      if (req.method === "GET" && pathname === "/api/status") {
        const clis = deps.detectClis ? await deps.detectClis() : [];
        const orchestratorModel = deps.orchestratorModel?.();
        return json({
          version: deps.version ?? "0.1.0",
          uptimeMs: Date.now() - startedAt,
          socket: deps.socketPath ?? "~/.vesper/run/vesper.sock",
          defaultCli: deps.defaultCli ?? null,
          clis,
          runs: store.listRuns().length,
          sessions: store.listSessions().length,
          uiPort: server.port,
          theme: themeId.length > 0 ? themeId : "dark",
          ...(orchestratorModel !== undefined ? { orchestratorModel } : {}),
        });
      }

      // GET /api/voice/config — the voice provider settings (never the key itself).
      if (req.method === "GET" && pathname === "/api/voice/config") {
        if (deps.voice === undefined) {
          return json({ tts: "local", voiceId: "", keyConfigured: false });
        }
        return json(await deps.voice.getConfig());
      }

      // POST /api/voice/config — persist voice provider settings entered in the UI.
      // Local-origin only (guarded above, the channel-token pattern): the API key
      // goes body -> keychain and is never echoed, logged, or audited.
      if (req.method === "POST" && pathname === "/api/voice/config") {
        if (deps.voice === undefined) return json({ error: "voice settings unavailable" }, 503);
        const body = await readJsonBody(req);
        const outcome = await deps.voice.setConfig({
          ...(typeof body?.tts === "string" ? { tts: body.tts } : {}),
          ...(typeof body?.voiceId === "string" ? { voiceId: body.voiceId } : {}),
          ...(typeof body?.apiKey === "string" ? { apiKey: body.apiKey } : {}),
        });
        return json({ ok: true, keyConfigured: outcome.keyConfigured });
      }

      // POST /api/voice/tts — synthesize one reply with the configured cloud voice.
      // Not configured / failed -> { available: false } and the chat falls back to
      // the browser's local voice; never an error page mid-conversation.
      if (req.method === "POST" && pathname === "/api/voice/tts") {
        const body = await readJsonBody(req);
        const text = typeof body?.text === "string" ? body.text.trim() : "";
        if (text.length === 0) return json({ error: "text is required" }, 400);
        if (deps.voice === undefined) return json({ available: false });
        try {
          const spoken = await deps.voice.tts(text);
          if (spoken === null) return json({ available: false });
          return new Response(spoken.audio.slice().buffer as ArrayBuffer, {
            headers: { "content-type": spoken.mime },
          });
        } catch {
          return json({ available: false });
        }
      }

      // GET /api/presence — agents running on this machine (Diagnostics; relocated
      // from the retired pixel-art home).
      if (req.method === "GET" && pathname === "/api/presence") {
        return json(await presenceNow());
      }

      // GET /api/connections — messaging-channel state (Connections page). Read-only
      // + local-only; channel mutations are CLI-only (`vesper connections ...`). When
      // no provider is wired, returns [] so the page degrades gracefully.
      if (req.method === "GET" && pathname === "/api/connections") {
        return json(deps.connections === undefined ? [] : await deps.connections.list());
      }

      // GET /api/skills — the skill library (read-only; shared across pipelines + Vesper).
      // Empty list when no provider is wired (e.g. a daemon launched outside the repo).
      if (req.method === "GET" && pathname === "/api/skills") {
        return json(deps.skills === undefined ? [] : await deps.skills.list());
      }

      // GET /api/models/directory — the live provider-grouped model list (the
      // picker's data). Fail-soft by contract: no provider wired or a failed
      // fetch serves { available: false } and the picker degrades to the catalog.
      if (req.method === "GET" && pathname === "/api/models/directory") {
        if (deps.modelDirectory === undefined) return json({ available: false, models: [] });
        try {
          return json({ available: true, models: await deps.modelDirectory.list() });
        } catch {
          return json({ available: false, models: [] });
        }
      }

      // GET /api/models — the benchmark snapshot + the invocable model catalog
      // (specs/orchestrator-home.md slice D). `stale` flags a snapshot older than
      // 7 days (the selector then falls back to the configured default).
      if (req.method === "GET" && pathname === "/api/models") {
        const rows = store.getModelBenchmarks(BENCHMARK_SOURCE);
        const fetchedAt = rows.length > 0 ? Math.max(...rows.map((r) => r.fetchedAt)) : null;
        const stale = fetchedAt === null || Date.now() - fetchedAt > 7 * 24 * 60 * 60 * 1_000;
        return json({
          source: BENCHMARK_SOURCE,
          fetchedAt,
          stale,
          rows: rows.map((r) => ({
            model: r.model,
            harness: r.harness,
            reasoningEffort: r.reasoningEffort,
            passAt1: r.passAt1,
            meanCostUsd: r.meanCostUsd,
          })),
          catalog: deps.modelsCatalog?.catalog ?? {},
          ...(deps.modelsCatalog?.default !== undefined
            ? { default: deps.modelsCatalog.default }
            : {}),
        });
      }

      // GET /api/memory — semantic-memory (RAG) status. Never throws. With a memory
      // provider wired it reports the live status (provider/model/dims + indexed count);
      // without one it reports the count-only unavailable status (degrades gracefully).
      if (req.method === "GET" && pathname === "/api/memory") {
        if (deps.memory === undefined) {
          return json(ragStatus({ configured: false, indexedDocuments: store.ragDocumentCount() }));
        }
        return json(await deps.memory.status());
      }

      // GET /api/memory/search?q=&k= — semantic search over indexed history. Local-only
      // (guarded above). Returns { hits, available }; a disabled engine yields
      // { hits: [], available: false } rather than an error so the Memory page degrades.
      if (req.method === "GET" && pathname === "/api/memory/search") {
        const q = (url.searchParams.get("q") ?? "").trim();
        if (q.length === 0) return json({ error: "q is required" }, 400);
        if (deps.memory === undefined) return json({ hits: [], available: false });
        const kRaw = Number(url.searchParams.get("k") ?? "5");
        const k = Number.isInteger(kRaw) && kRaw > 0 ? Math.min(kRaw, 20) : 5;
        try {
          const hits = await deps.memory.search(q, k);
          return json({ hits, available: true });
        } catch (err) {
          if (err instanceof StorageError && err.reason === "rag_unavailable") {
            return json({ hits: [], available: false });
          }
          return json({ error: err instanceof Error ? err.message : "search failed" }, 500);
        }
      }

      // GET /api/skills/:name — one skill's full detail. The name is kebab-shaped
      // (defense-in-depth above the provider's own path-traversal guard); 404 when unknown.
      const skillMatch = pathname.match(/^\/api\/skills\/([^/]+)$/);
      if (req.method === "GET" && skillMatch) {
        if (deps.skills === undefined) return json({ error: "skills not available" }, 503);
        const name = decodeURIComponent(skillMatch[1] ?? "");
        if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) return json({ error: "invalid skill name" }, 400);
        try {
          const detail = await deps.skills.get(name);
          return detail === null ? json({ error: "unknown skill" }, 404) : json(detail);
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : "could not read skill" }, 400);
        }
      }

      // POST /api/connections/:id/token — store a channel credential entered in the UI
      // (vault set + enable in config). Body: { token, params? }. Local-origin only
      // (guarded above) by design — NO approval code (specs/channel-auto-onboarding.md
      // Slice 0). Fail-closed (503) when no setToken is wired. The token is read from the
      // body, handed straight to the vault, and never echoed back, logged, or audited.
      const tokenMatch = pathname.match(/^\/api\/connections\/([^/]+)\/token$/);
      if (req.method === "POST" && tokenMatch) {
        if (deps.connections?.setToken === undefined) {
          return json({ error: "token entry is not available" }, 503);
        }
        const id = decodeURIComponent(tokenMatch[1] ?? "");
        const body = await readJsonBody(req);
        const token = typeof body?.token === "string" ? body.token.trim() : "";
        if (token.length === 0) return json({ error: "token is required" }, 400);
        const params: Record<string, string> = {};
        if (isRecord(body?.params)) {
          for (const [k, v] of Object.entries(body.params)) {
            if (typeof v === "string") params[k] = v;
          }
        }
        try {
          await deps.connections.setToken(id, token, params);
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : "could not save token" }, 400);
        }
        // Audit the mutation WITHOUT the secret (channel + method only).
        store.appendEvent({
          source: "connections",
          kind: "token_set",
          payload: { channel: id, method: "manual" },
        });
        return json({ ok: true });
      }

      // POST /api/connections/:id/setup — AUTO-ONBOARD a token channel: drive the user's
      // CLI (agent-browser) to mint the token, persist it, and stream progress as ndjson
      // (same shape family as /pair). Local-only (guarded above); the stream carries
      // progress + a terminal status, never the token. Closing the connection cancels it.
      // Best-effort: a blocked automation ends `awaiting_user` so the UI shows the manual
      // token field — not an error.
      const setupMatch = pathname.match(/^\/api\/connections\/([^/]+)\/setup$/);
      if (req.method === "POST" && setupMatch) {
        if (deps.connections?.setup === undefined) {
          return json({ error: "channel setup is not available" }, 503);
        }
        const channelId = decodeURIComponent(setupMatch[1] ?? "");
        const session = deps.connections.setup(channelId);
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const onAbort = (): void => session.stop();
            req.signal.addEventListener("abort", onAbort);
            try {
              for await (const update of session.updates()) {
                controller.enqueue(encoder.encode(`${JSON.stringify(update)}\n`));
                if (update.status !== "working") break; // working may repeat; else terminal
              }
            } catch (err) {
              const reason = err instanceof Error ? err.message : String(err);
              controller.enqueue(
                encoder.encode(`${JSON.stringify({ status: "error", reason })}\n`),
              );
            } finally {
              req.signal.removeEventListener("abort", onAbort);
              session.stop();
              controller.close();
            }
          },
        });
        return new Response(stream, {
          headers: { "content-type": "application/x-ndjson; charset=utf-8" },
        });
      }

      // GET /api/qr?data=... — encode a string as a QR matrix ({size, modules}) so the
      // browser can draw a scannable code on a canvas WITHOUT bundling the core encoder
      // (the @vesper/core barrel pulls bun:sqlite, which cannot run in the browser).
      // Local-only (guarded above); length-bounded so a giant payload can't hog CPU.
      if (req.method === "GET" && pathname === "/api/qr") {
        const data = url.searchParams.get("data") ?? "";
        if (data.length === 0) return json({ error: "data is required" }, 400);
        if (data.length > 2048) return json({ error: "data too long" }, 413);
        try {
          return json(encodeQr(data));
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : "qr encode failed" }, 400);
        }
      }

      // POST /api/connections/:id/pair — begin scan-to-connect pairing for one channel
      // and stream PairingUpdates as newline-delimited JSON (consumed identically by the
      // `vesper connections pair` CLI and the Vesper World Connect card). Local-only
      // (guarded above); the stream carries non-secret nonces/links + the captured chat
      // id, never a token. Closing the connection cancels the session.
      const pairMatch = pathname.match(/^\/api\/connections\/([^/]+)\/pair$/);
      if (req.method === "POST" && pairMatch) {
        if (deps.pairing === undefined) {
          return json({ error: "pairing is not available" }, 503);
        }
        const channelId = decodeURIComponent(pairMatch[1] ?? "");
        const session = await deps.pairing.startPairing(channelId);
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const onAbort = (): void => session.stop();
            req.signal.addEventListener("abort", onAbort);
            try {
              for await (const update of session.updates()) {
                controller.enqueue(encoder.encode(`${JSON.stringify(update)}\n`));
                // awaiting may repeat (rotating QR); any other status is terminal.
                if (update.status !== "awaiting") break;
              }
            } catch (err) {
              const reason = err instanceof Error ? err.message : String(err);
              controller.enqueue(
                encoder.encode(`${JSON.stringify({ status: "error", reason })}\n`),
              );
            } finally {
              req.signal.removeEventListener("abort", onAbort);
              session.stop();
              controller.close();
            }
          },
        });
        return new Response(stream, {
          headers: { "content-type": "application/x-ndjson; charset=utf-8" },
        });
      }

      // GET /api/runs?limit= — recent runs (newest-first) for Diagnostics.
      if (req.method === "GET" && pathname === "/api/runs") {
        const limitRaw = Number(url.searchParams.get("limit") ?? "50");
        const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, limitRaw)) : 50;
        const rows = store
          .listRuns({ limit })
          .slice()
          .sort((a, b) => b.ts - a.ts)
          .map((r) => ({
            id: r.id,
            pipeline: r.pipeline,
            status: r.status,
            summary: r.summary,
            ts: r.ts,
          }));
        return json(rows);
      }

      // GET /api/runs/:runId/events?afterTs= — replay/backfill the persisted
      // live-trace for one run (the durable analogue of the live WS stream; a late or
      // reconnecting client reads this before joining the live stream).
      const eventsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
      if (req.method === "GET" && eventsMatch) {
        const runId = decodeURIComponent(eventsMatch[1] ?? "");
        if (!UUID_RE.test(runId)) return json({ error: "invalid runId" }, 400);
        const afterRaw = url.searchParams.get("afterTs");
        const afterTs = afterRaw === null ? undefined : Number(afterRaw);
        const rows = store.listRunEvents({
          runId,
          ...(afterTs !== undefined && Number.isFinite(afterTs) ? { afterTs } : {}),
          limit: 500,
        });
        const events: RunEventInfo[] = rows.map((r) => ({
          id: r.id,
          runId: r.runId,
          ts: r.ts,
          kind: r.kind,
          message: typeof r.payload.message === "string" ? r.payload.message : "",
          ...(isRecord(r.payload.data) ? { data: r.payload.data } : {}),
        }));
        return json(events);
      }

      // GET /api/runs/:runId/tree — the run hierarchy (parent + spawned children),
      // assembled server-side so the activity panel stays a thin renderer.
      const treeMatch = pathname.match(/^\/api\/runs\/([^/]+)\/tree$/);
      if (req.method === "GET" && treeMatch) {
        const runId = decodeURIComponent(treeMatch[1] ?? "");
        if (!UUID_RE.test(runId)) return json({ error: "invalid runId" }, 400);
        const tree = store.runTree(runId);
        return tree === null ? json({ error: "unknown run" }, 404) : json(mapTreeToInfo(tree));
      }

      // GET /api/runs/:runId/diff?changeId=&staged= — the structured per-file diff of a
      // software-engineer proposed change, rendered GitHub-PR style. Read-only; behind
      // isLocalRequest (above) + the UUID guard. 503 when no provider is wired.
      const diffMatch = pathname.match(/^\/api\/runs\/([^/]+)\/diff$/);
      if (req.method === "GET" && diffMatch) {
        const runId = decodeURIComponent(diffMatch[1] ?? "");
        if (!UUID_RE.test(runId)) return json({ error: "invalid runId" }, 400);
        if (deps.softwareEngineer === undefined) {
          return json({ error: "software-engineer surface not configured" }, 503);
        }
        const changeId = url.searchParams.get("changeId");
        const stagedRaw = url.searchParams.get("staged");
        const view = await deps.softwareEngineer.loadDiff(runId, {
          ...(changeId !== null && changeId.length > 0 ? { changeId } : {}),
          staged: stagedRaw === "1" || stagedRaw === "true",
        });
        return view === null ? json({ error: "no diff for run" }, 404) : json(view);
      }

      // POST /api/runs/:runId/changes/:changeId/decision — deliver a human approve/reject
      // to a BLOCKED software-engineer cycle. Requires isLocalRequest (above) AND a valid
      // single-use out-of-band approval code: isLocalRequest stops CSRF/DNS-rebinding but
      // does not prove human intent. Body: { decision: "approve"|"reject", reason? }.
      const decisionMatch = pathname.match(/^\/api\/runs\/([^/]+)\/changes\/([^/]+)\/decision$/);
      if (req.method === "POST" && decisionMatch) {
        const runId = decodeURIComponent(decisionMatch[1] ?? "");
        if (!UUID_RE.test(runId)) return json({ error: "invalid runId" }, 400);
        const tokenError = requireApproval(req, deps.approvalTokens);
        if (tokenError !== null) return tokenError;
        if (deps.softwareEngineer === undefined) {
          return json({ error: "software-engineer surface not configured" }, 503);
        }
        const changeId = decodeURIComponent(decisionMatch[2] ?? "");
        const body: unknown = await req.json().catch(() => null);
        const decision = isRecord(body) ? body.decision : undefined;
        if (decision !== "approve" && decision !== "reject") {
          return json({ error: "decision must be 'approve' or 'reject'" }, 400);
        }
        const reason = isRecord(body) && typeof body.reason === "string" ? body.reason : undefined;
        const delivered = deps.softwareEngineer.decide(runId, changeId, {
          decision,
          ...(reason !== undefined ? { reason } : {}),
        });
        return delivered
          ? json({ ok: true, decision })
          : json({ error: "no change awaiting this decision" }, 409);
      }

      // POST /api/pipelines/:id/run — optional JSON body `{ params?, cli? }` supplies the
      // transient run inputs a manual pipeline needs (e.g. the software-engineer lead's
      // `repo` + `wish`). No body keeps the prior no-params behavior.
      const runMatch = pathname.match(/^\/api\/pipelines\/([^/]+)\/run$/);
      if (req.method === "POST" && runMatch) {
        const id = decodeURIComponent(runMatch[1] ?? "");
        const runBody = await readJsonBody(req);
        const params = isRecord(runBody?.params) ? runBody.params : undefined;
        const cli = typeof runBody?.cli === "string" ? runBody.cli : undefined;
        const runOpts = {
          ...(params !== undefined ? { params } : {}),
          ...(cli !== undefined ? { cli } : {}),
        };
        try {
          const outcome = await scheduler.run(id, runOpts);
          return json(outcome);
        } catch (err) {
          if (err instanceof SchedulerError && err.reason === "unknown_task") {
            return json({ error: `unknown agent "${id}"` }, 404);
          }
          return json({ error: err instanceof Error ? err.message : String(err) }, 500);
        }
      }

      // ── Autonomous loop ──────────────────────────────────────────────────
      // POST /api/loop/run — start an autonomous loop (specs/autonomous-loop.md) and
      // return its runId IMMEDIATELY (202) so the client can follow the live
      // author/execute/critic trace while the loop runs; the terminal outcome arrives
      // later as the `run:completed` world frame. The scheduler allocates the run row
      // up front (`startRun`), so a brief poll for a fresh `loop` run row yields the
      // id without waiting for completion. Behind isLocalRequest (above) like every
      // mutating route; the loop pipeline itself is capability-sandboxed to
      // CLI_INVOKE + WRITE_STORAGE (a pure reasoning loop).
      if (req.method === "POST" && pathname === "/api/loop/run") {
        const body = await readJsonBody(req);
        const goal = typeof body?.goal === "string" ? body.goal.trim() : "";
        if (goal.length === 0) return json({ error: "goal is required" }, 400);
        const params: Record<string, string> = { goal };
        const maxIterations = body?.maxIterations;
        if (typeof maxIterations === "number" && Number.isInteger(maxIterations)) {
          params.maxIterations = String(maxIterations);
        }
        if (typeof body?.successCriteria === "string" && body.successCriteria.trim().length > 0) {
          params.successCriteria = body.successCriteria.trim();
        }

        const before = new Set(store.listRuns({ pipeline: "loop" }).map((r) => r.id));
        let failure: unknown = null;
        scheduler.run("loop", { params }).catch((err: unknown) => {
          failure = err; // surfaced below when the run dies before its row appears
        });
        for (let attempt = 0; attempt < 40; attempt++) {
          const fresh = store.listRuns({ pipeline: "loop" }).find((r) => !before.has(r.id));
          if (fresh !== undefined) return json({ runId: fresh.id }, 202);
          if (failure !== null) {
            return json(
              { error: failure instanceof Error ? failure.message : String(failure) },
              500,
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return json({ error: "the loop did not start in time" }, 500);
      }

      // ── Chatbot home ─────────────────────────────────────────────────────
      // POST /api/chat — a chat message is a manual run of the `router` pipeline
      // through the EXISTING run path (no new execution). Persists the user turn,
      // runs the router, persists the assistant turn carrying its runId, audits the
      // mutation, and publishes both turns to the session's chat:<id> WS topic.
      if (req.method === "POST" && pathname === "/api/chat") {
        const body = await readJsonBody(req);
        const message = typeof body?.message === "string" ? body.message : "";
        if (message.trim().length === 0) {
          return json({ error: "message is required" }, 400);
        }
        const requested = typeof body?.sessionId === "string" ? body.sessionId : null;
        if (requested !== null && !UUID_RE.test(requested)) {
          return json({ error: "invalid sessionId" }, 400);
        }

        // Create the session lazily; a brand-new session is titled from the message.
        // A client-SUPPLIED unknown id is created with that exact id — this lets the
        // client subscribe to chat:<id> BEFORE the first send, so the first reply's
        // chat:delta stream is not missed (UI + `vesper chat` both rely on it).
        let sessionId: string;
        if (requested === null) {
          sessionId = store.createSession({ title: message.slice(0, 80) });
        } else {
          const exists = store.listSessions().some((s) => s.id === requested);
          sessionId = exists
            ? requested
            : store.createSession({ id: requested, title: message.slice(0, 80) });
        }
        const userTurnId = store.appendTurn({ sessionId, role: "user", text: message });
        publishChatTurn(server, sessionId, {
          turnId: userTurnId,
          runId: null,
          role: "user",
          text: message,
        });

        let outcome: RunOutcome;
        try {
          outcome = await scheduler.run("router", { params: { message, sessionId } });
        } catch (err) {
          if (err instanceof SchedulerError && err.reason === "unknown_task") {
            return json({ error: "router pipeline is not registered" }, 500);
          }
          return json({ error: err instanceof Error ? err.message : String(err) }, 500);
        }

        const assistantText = outcome.summary ?? "(no response)";
        const turnId = store.appendTurn({
          sessionId,
          role: "assistant",
          text: assistantText,
          runId: outcome.runId,
        });
        publishChatTurn(server, sessionId, {
          turnId,
          runId: outcome.runId,
          role: "assistant",
          text: assistantText,
        });
        store.appendEvent({
          source: "chat",
          kind: "message",
          payload: { sessionId, turnId, runId: outcome.runId },
        });
        // `reply` lets a non-browser caller (the Telegram ChatSink) deliver the
        // assistant's response back over its channel from this single round-trip.
        return json({ sessionId, turnId, runId: outcome.runId, reply: assistantText });
      }

      // GET /api/chat/sessions — the session list (newest-first) for the home.
      if (req.method === "GET" && pathname === "/api/chat/sessions") {
        return json(store.listSessions());
      }

      // GET /api/chat/sessions/:id/turns?afterTs= — replay/backfill a transcript.
      const turnsMatch = pathname.match(/^\/api\/chat\/sessions\/([^/]+)\/turns$/);
      if (req.method === "GET" && turnsMatch) {
        const sessionId = decodeURIComponent(turnsMatch[1] ?? "");
        if (!UUID_RE.test(sessionId)) return json({ error: "invalid sessionId" }, 400);
        const afterRaw = url.searchParams.get("afterTs");
        const afterTs = afterRaw === null ? undefined : Number(afterRaw);
        const turns = store.listTurns({
          sessionId,
          ...(afterTs !== undefined && Number.isFinite(afterTs) ? { afterTs } : {}),
          limit: 500,
        });
        return json(turns);
      }

      // ── Custom pipelines (specs/pipeline-editor.md) ──────────────────────
      // GET /api/pipelines/custom — active user-authored pipelines at a glance.
      if (req.method === "GET" && pathname === "/api/pipelines/custom") {
        return json(deps.customPipelines?.list() ?? []);
      }

      // GET /api/pipelines/custom/targets — the contract targets the editor's
      // `pipeline` steps may name (must match BEFORE the /:id matcher below).
      if (req.method === "GET" && pathname === "/api/pipelines/custom/targets") {
        return json(deps.customPipelines?.targets() ?? []);
      }

      // POST /api/pipelines/custom/sync — re-sweep the markdown drop folder.
      if (req.method === "POST" && pathname === "/api/pipelines/custom/sync") {
        if (deps.syncPipelinesFolder === undefined) {
          return json({ error: "the pipelines folder is not configured" }, 503);
        }
        return json(await deps.syncPipelinesFolder());
      }

      // POST /api/pipelines/custom/markdown — parse a markdown pipeline document
      // to its raw doc (+ validation outcome). Read-only; the editor's Markdown
      // tab and `vesper pipeline save <file.md>` share this converter.
      if (req.method === "POST" && pathname === "/api/pipelines/custom/markdown") {
        if (deps.customPipelines === undefined) {
          return json({ error: "custom pipelines are not configured" }, 503);
        }
        const body = await readJsonBody(req);
        if (body === null || typeof body.source !== "string") {
          return json({ error: "body must be { source }" }, 400);
        }
        return json(deps.customPipelines.parseMarkdown(body.source));
      }

      // POST /api/pipelines/custom/markdown/serialize — doc -> markdown form.
      if (req.method === "POST" && pathname === "/api/pipelines/custom/markdown/serialize") {
        if (deps.customPipelines === undefined) {
          return json({ error: "custom pipelines are not configured" }, 503);
        }
        const body = await readJsonBody(req);
        if (body === null || !isRecord(body.doc)) {
          return json({ error: "body must be { doc }" }, 400);
        }
        const markdown = deps.customPipelines.serializeMarkdown(body.doc);
        return markdown === null
          ? json({ error: "the document is not valid" }, 422)
          : json({ markdown });
      }

      // POST /api/pipelines/custom/validate — fail-closed dry-run of a doc (no
      // persistence, no approval): the editor's live check + `save --validate`.
      if (req.method === "POST" && pathname === "/api/pipelines/custom/validate") {
        if (deps.customPipelines === undefined) {
          return json({ error: "custom pipelines are not configured" }, 503);
        }
        const body = await readJsonBody(req);
        if (body === null || !isRecord(body.doc)) {
          return json({ error: "body must be { doc }" }, 400);
        }
        return json(deps.customPipelines.validate(body.doc));
      }

      // POST /api/pipelines/custom/:id/improve — "Improve with AI": Vesper audits the
      // WHOLE doc (+ optional single-step scope) and returns a PROPOSAL. Read-only —
      // nothing changes until the user accepts fields and saves (approval-gated).
      const improveMatch = pathname.match(/^\/api\/pipelines\/custom\/([^/]+)\/improve$/);
      if (req.method === "POST" && improveMatch) {
        if (deps.customPipelines === undefined) {
          return json({ error: "custom pipelines are not configured" }, 503);
        }
        const id = decodeURIComponent(improveMatch[1] ?? "");
        const body = await readJsonBody(req);
        const scope =
          typeof body?.scope === "string" && body.scope.trim().length > 0
            ? body.scope.trim()
            : undefined;
        try {
          const proposal = await deps.customPipelines.improve(id, scope);
          return proposal === null
            ? json({ error: "no proposal (unknown pipeline or unparseable reply)" }, 422)
            : json(proposal);
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 500);
        }
      }

      // GET/PUT/DELETE /api/pipelines/custom/:id — read one doc; save (validate ->
      // persist -> re-register, approval-gated); archive (NEVER a row delete —
      // Hard rule 4 — approval-gated).
      const customMatch = pathname.match(/^\/api\/pipelines\/custom\/([^/]+)$/);
      if (customMatch) {
        if (deps.customPipelines === undefined) {
          return json({ error: "custom pipelines are not configured" }, 503);
        }
        const id = decodeURIComponent(customMatch[1] ?? "");
        if (req.method === "GET") {
          const detail = deps.customPipelines.get(id);
          return detail === null
            ? json({ error: `unknown custom pipeline "${id}"` }, 404)
            : json(detail);
        }
        if (req.method === "PUT") {
          const tokenError = requireApproval(req, deps.approvalTokens);
          if (tokenError !== null) return tokenError;
          const body = await readJsonBody(req);
          if (body === null || !isRecord(body.doc)) {
            return json({ error: "body must be { doc }" }, 400);
          }
          const outcome = deps.customPipelines.save(id, body.doc);
          return json(outcome, outcome.ok ? 200 : 422);
        }
        if (req.method === "DELETE") {
          const tokenError = requireApproval(req, deps.approvalTokens);
          if (tokenError !== null) return tokenError;
          return deps.customPipelines.archive(id)
            ? json({ ok: true })
            : json({ error: `unknown custom pipeline "${id}"` }, 404);
        }
      }

      // ── Editable pipeline templates ──────────────────────────────────────
      // GET /api/pipelines — registered tasks + their editable ScheduledTask config.
      if (req.method === "GET" && pathname === "/api/pipelines") {
        return json(scheduler.list().map(toPipelineConfig));
      }

      // GET /api/pipelines/:id/template — the editable prompt + default params + config.
      const templateMatch = pathname.match(/^\/api\/pipelines\/([^/]+)\/template$/);
      if (req.method === "GET" && templateMatch) {
        const id = decodeURIComponent(templateMatch[1] ?? "");
        const task = scheduler.list().find((t) => t.id === id);
        if (task === undefined) return json({ error: `unknown pipeline "${id}"` }, 404);
        const template = store.getTemplate(task.handler_id);
        return json({
          handlerId: task.handler_id,
          prompt: template?.prompt ?? "",
          defaultParams: template?.defaultParams ?? {},
          // The built-in's read-only prompt catalog (real handler prompts with
          // {{...}} placeholders); [] when the daemon wired no provider.
          prompts: deps.getBuiltinPrompts?.(task.handler_id) ?? [],
          config: toPipelineConfig(task),
        });
      }

      // PUT /api/pipelines/:id/template — the PRIVILEGED config mutation. Behind
      // isLocalRequest (above) AND a single-use out-of-band approval code. A rejected
      // edit is a row upsert, never a destructive file op (Hard rule 4).
      if (req.method === "PUT" && templateMatch) {
        const id = decodeURIComponent(templateMatch[1] ?? "");
        const tokenError = requireApproval(req, deps.approvalTokens);
        if (tokenError !== null) return tokenError;

        const task = scheduler.list().find((t) => t.id === id);
        if (task === undefined) return json({ error: `unknown pipeline "${id}"` }, 404);

        const body = await readJsonBody(req);
        if (body === null) return json({ error: "invalid JSON body" }, 400);
        const prompt = typeof body.prompt === "string" ? body.prompt : "";
        const defaultParams = isRecord(body.defaultParams) ? body.defaultParams : {};
        store.upsertTemplate({ handlerId: task.handler_id, prompt, defaultParams });
        store.appendEvent({
          source: "templates",
          kind: "updated",
          payload: { pipelineId: id, handlerId: task.handler_id },
        });
        return json({ ok: true, handlerId: task.handler_id });
      }

      // POST /api/approval/request — mint a single-use approval code and surface it
      // OUT-OF-BAND on the daemon's own stdout (the operator's `vesper daemon` terminal).
      // The HTTP response NEVER carries the code, so a malicious local app can trigger a
      // mint but cannot READ it — only the operator at the foreground terminal sees it.
      // The operator pastes it into the privileged-mutation form (`x-vesper-approval`).
      if (req.method === "POST" && pathname === "/api/approval/request") {
        if (deps.approvalTokens === undefined) {
          return json({ error: "approval is not configured" }, 403);
        }
        const code = deps.approvalTokens.mint();
        process.stdout.write(
          `\n  Vesper approval code: ${code}  (single-use, expires shortly)\n\n`,
        );
        return json({ ok: true });
      }

      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        ws.subscribe("world");
      },
      message(ws, raw) {
        // Control protocol, two topic families on ONE socket:
        //   {type:'subscribe'|'unsubscribe', runId}     -> a run's live trace (agent:<runId>)
        //   {type:'subscribe'|'unsubscribe', sessionId}  -> a chat transcript (chat:<sessionId>)
        // Each id is guarded by UUID shape (rejects crafted/wildcard topics); malformed
        // frames are ignored silently — the connection is already local-origin (upgrade
        // is guarded).
        try {
          const msg: unknown = JSON.parse(typeof raw === "string" ? raw : raw.toString());
          if (!isRecord(msg)) return;
          const { type, runId, sessionId } = msg;
          if (typeof runId === "string" && UUID_RE.test(runId)) {
            if (type === "subscribe") ws.subscribe(`agent:${runId}`);
            else if (type === "unsubscribe") ws.unsubscribe(`agent:${runId}`);
          } else if (typeof sessionId === "string" && UUID_RE.test(sessionId)) {
            if (type === "subscribe") ws.subscribe(`chat:${sessionId}`);
            else if (type === "unsubscribe") ws.unsubscribe(`chat:${sessionId}`);
          }
        } catch {
          // Non-JSON / unexpected payload — ignore.
        }
      },
      close() {
        // Bun auto-unsubscribes on close.
      },
    },
  });

  // Push every completed run to connected browsers + notify modules (e.g. Voice).
  const onRun = (payload?: unknown): void => {
    const outcome = payload as RunOutcome;
    server.publish("world", JSON.stringify({ type: "run:completed", outcome }));
    void modules.dispatchRunCompleted(outcome);
  };
  scheduler.eventBus.on(RUN_COMPLETED, onRun);

  // Push every live-trace step to clients following that exact run (agent:<runId>),
  // plus a cheap lite pulse on the 'world' topic so the home view can react without
  // subscribing to a specific run.
  const onRunEvent = (payload?: unknown): void => {
    if (!isRecord(payload) || typeof payload.runId !== "string") return;
    const event = payload as unknown as RunEventPayload;
    // Streamed assistant deltas (publish-only "text" kind) ride to the chat
    // transcript topic as chat:delta frames; they never hit the agent log.
    if (event.kind === "text") {
      const sessionId = isRecord(event.data) ? event.data.sessionId : undefined;
      if (typeof sessionId === "string" && UUID_RE.test(sessionId)) {
        server.publish(
          `chat:${sessionId}`,
          JSON.stringify({ type: "chat:delta", runId: event.runId, text: event.message }),
        );
      }
      return;
    }
    server.publish(`agent:${event.runId}`, JSON.stringify({ type: "run:event", event }));
    server.publish(
      "world",
      JSON.stringify({ type: "run:event:lite", runId: event.runId, kind: event.kind }),
    );
  };
  scheduler.eventBus.on(RUN_EVENT, onRunEvent);

  const url = `http://${hostname}:${server.port}`;
  return {
    port: server.port,
    url,
    stop() {
      scheduler.eventBus.off(RUN_COMPLETED, onRun);
      scheduler.eventBus.off(RUN_EVENT, onRunEvent);
      server.stop(true);
    },
  };
}
