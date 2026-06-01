import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApprovalTokenStore, RunOutcome, RunTreeNode, Scheduler, Store } from "@vesper/core";
import { ApprovalError, RUN_COMPLETED, RUN_EVENT, SchedulerError } from "@vesper/core";
import { ModuleRegistry } from "../modules/registry.ts";
import type { UiModule } from "../modules/types.ts";
import type { PresenceInfo, RunEventInfo, RunTreeInfo } from "../world/types.ts";
import { defaultPresenceDetector, type PresenceDetector, presenceSignature } from "./presence.ts";
import { buildSnapshot } from "./snapshot.ts";

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

/** Dependencies for {@link startUiServer}. */
export interface UiServerDeps {
  readonly scheduler: Scheduler;
  readonly store: Store;
  /** Stable per-machine seed (fingerprint) for the deterministic world. */
  readonly seed: string;
  readonly port?: number;
  readonly hostname?: string;
  /** Optional pluggable UI modules (e.g. Voice). MVP passes none. */
  readonly modules?: readonly UiModule[];
  /** Detects agents running on this machine. Defaults to the real `ps` scanner. */
  readonly detectPresences?: PresenceDetector;
  /** How often to re-scan for running agents (ms). Default 3000. */
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
 * Routes: `GET /` (client shell), `GET /app.js` (bundled client), `GET /api/world`
 * (current {@link import("../world/types.ts").SceneGraph}), `POST /api/pipelines/:id/run`
 * (run a pipeline -> {@link RunOutcome}), `GET /api/runs/:runId/events?afterTs=`
 * (replay a run's persisted live trace), `GET /api/runs/:runId/tree` (the run +
 * sub-agent hierarchy), and `WS /api/live` (pushes `run:completed`, `presence`,
 * `run:event:lite`; a `{type:'subscribe'|'unsubscribe', runId}` frame joins/leaves a
 * single run's `run:event` stream).
 *
 * Bound to localhost only — single-user local runtime, no auth. The trace routes and
 * the WS subscribe topic both require a UUID-shaped `runId` and sit behind the same
 * local-origin guard as every other route.
 */
export async function startUiServer(deps: UiServerDeps): Promise<UiServerHandle> {
  const { scheduler, store, seed } = deps;
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

  // Live presence: the agents running on this machine right now. Detected once at
  // startup, then re-scanned on an interval; the latest set feeds every /api/world.
  const detect = deps.detectPresences ?? defaultPresenceDetector();
  const pollMs = deps.presencePollMs ?? 3_000;
  let presences: PresenceInfo[] = await detect();
  let presenceSig = presenceSignature(presences);

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
      if (req.method === "GET" && pathname === "/api/world") {
        return json(buildSnapshot(scheduler, store, seed, presences));
      }

      // GET /api/runs/:runId/events?afterTs= — replay/backfill the persisted
      // live-trace for one run (the durable analogue of /api/world; a late or
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

      // POST /api/pipelines/:id/run
      const runMatch = pathname.match(/^\/api\/pipelines\/([^/]+)\/run$/);
      if (req.method === "POST" && runMatch) {
        const id = decodeURIComponent(runMatch[1] ?? "");
        try {
          const outcome = await scheduler.run(id);
          return json(outcome);
        } catch (err) {
          if (err instanceof SchedulerError && err.reason === "unknown_task") {
            return json({ error: `unknown agent "${id}"` }, 404);
          }
          return json({ error: err instanceof Error ? err.message : String(err) }, 500);
        }
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
        const sessionId = requested ?? store.createSession({ title: message.slice(0, 80) });
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
        return json({ sessionId, turnId, runId: outcome.runId });
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
    server.publish(`agent:${event.runId}`, JSON.stringify({ type: "run:event", event }));
    server.publish(
      "world",
      JSON.stringify({ type: "run:event:lite", runId: event.runId, kind: event.kind }),
    );
  };
  scheduler.eventBus.on(RUN_EVENT, onRunEvent);

  // Re-scan running agents on an interval; push a refresh only when the set
  // actually changes (an agent started/stopped), so idle ticks are silent.
  const poll = async (): Promise<void> => {
    const next = await detect();
    const nextSig = presenceSignature(next);
    if (nextSig === presenceSig) return;
    presences = next;
    presenceSig = nextSig;
    server.publish("world", JSON.stringify({ type: "presence" }));
  };
  const pollTimer = setInterval(() => {
    void poll();
  }, pollMs);

  const url = `http://${hostname}:${server.port}`;
  return {
    port: server.port,
    url,
    stop() {
      clearInterval(pollTimer);
      scheduler.eventBus.off(RUN_COMPLETED, onRun);
      scheduler.eventBus.off(RUN_EVENT, onRunEvent);
      server.stop(true);
    },
  };
}
