import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunOutcome, RunTreeNode, Scheduler, Store } from "@vesper/core";
import { RUN_COMPLETED, RUN_EVENT, SchedulerError } from "@vesper/core";
import { ModuleRegistry } from "../modules/registry.ts";
import type { UiModule } from "../modules/types.ts";
import type { PresenceInfo, RunEventInfo, RunTreeInfo } from "../world/types.ts";
import { defaultPresenceDetector, type PresenceDetector, presenceSignature } from "./presence.ts";
import { buildSnapshot } from "./snapshot.ts";

const CLIENT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "client");

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

  const baseHtml = await Bun.file(join(CLIENT_DIR, "index.html")).text();
  // Stamp the configured default theme into the page (sanitized to [a-z0-9-]) so the
  // client can read it via <meta name="vesper-theme">. Shell templating only.
  const themeId = (deps.defaultTheme ?? "").replace(/[^a-z0-9-]/gi, "");
  const indexHtml =
    themeId.length > 0
      ? baseHtml.replace(
          "</head>",
          `    <meta name="vesper-theme" content="${themeId}" />\n  </head>`,
        )
      : baseHtml;
  const appJs = await buildClientBundle();

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

      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        ws.subscribe("world");
      },
      message(ws, raw) {
        // Control protocol: {type:'subscribe'|'unsubscribe', runId}. A client follows
        // one run's live trace by subscribing to its agent:<runId> topic. The runId is
        // guarded by UUID shape (rejects crafted/wildcard topics); malformed frames are
        // ignored silently — the connection is already local-origin (upgrade is guarded).
        try {
          const msg: unknown = JSON.parse(typeof raw === "string" ? raw : raw.toString());
          if (!isRecord(msg)) return;
          const { type, runId } = msg;
          if (typeof runId !== "string" || !UUID_RE.test(runId)) return;
          if (type === "subscribe") ws.subscribe(`agent:${runId}`);
          else if (type === "unsubscribe") ws.unsubscribe(`agent:${runId}`);
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
