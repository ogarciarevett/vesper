import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunOutcome, Scheduler, Store } from "@vesper/core";
import { RUN_COMPLETED, SchedulerError } from "@vesper/core";
import { ModuleRegistry } from "../modules/registry.ts";
import type { UiModule } from "../modules/types.ts";
import type { PresenceInfo } from "../world/types.ts";
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
 * (run a pipeline -> {@link RunOutcome}), and `WS /api/live` (pushes `run:completed`).
 *
 * Bound to localhost only — single-user local runtime, no auth.
 */
export async function startUiServer(deps: UiServerDeps): Promise<UiServerHandle> {
  const { scheduler, store, seed } = deps;
  const hostname = deps.hostname ?? "127.0.0.1";
  const port = deps.port ?? 4317;
  const modules = new ModuleRegistry(deps.modules ?? []);

  const indexHtml = await Bun.file(join(CLIENT_DIR, "index.html")).text();
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
      message() {
        // The client only listens; inbound messages are ignored.
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
      server.stop(true);
    },
  };
}
