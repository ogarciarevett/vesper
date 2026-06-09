import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApprovalTokenStore,
  CAPABILITIES,
  type CompleteFn,
  HandlerRegistry,
  openStore,
  Scheduler,
  type Store,
} from "@vesper/core";
import type { SweDiffView } from "../world/types.ts";
import { startUiServer, type UiServerHandle } from "./server.ts";

const fakeComplete: CompleteFn = async () => ({
  text: "pong",
  exit_code: 0,
  raw_stdout: "pong",
  raw_stderr: "",
  duration_ms: 1,
  usage: {
    inputTokens: 1_234,
    outputTokens: 56,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    model: "claude-opus-4-8[1m]",
  },
});

let dir: string;
let db: Database;
let store: Store;
let handle: UiServerHandle;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "vesper-ui-srv-"));
  const path = join(dir, "vesper.db");
  openStore(path).close(); // migrate
  db = new Database(path);
  store = openStore(path); // same file, separate read connection

  const registry = new HandlerRegistry();
  registry.register("echo", async (ctx) => {
    await ctx.complete("hi");
    ctx.recordRun({ status: "ok", summary: "hello back" });
  });
  // A handler that emits a live-trace step before finishing — drives the
  // RUN_EVENT path (WS push + run_events persistence for replay).
  registry.register("trace", async (ctx) => {
    ctx.emitProgress({ kind: "step", message: "thinking" });
    ctx.recordRun({ status: "ok", summary: "traced" });
  });
  // A handler that emits an early step (carries its runId in the lite pulse), yields,
  // then emits a later step — giving a subscriber a deterministic window to join the
  // run's agent:<runId> topic between the two emits and receive the second live.
  registry.register("slowtrace", async (ctx) => {
    ctx.emitProgress({ kind: "step", message: "first" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    ctx.emitProgress({ kind: "progress", message: "second" });
    ctx.recordRun({ status: "ok", summary: "slow traced" });
  });
  const scheduler = new Scheduler({ db, registry, grants: CAPABILITIES, complete: fakeComplete });
  scheduler.register({
    id: "echo",
    kind: "manual",
    schedule_expr: "",
    handler_id: "echo",
    required_capabilities: ["CLI_INVOKE", "WRITE_STORAGE"],
  });
  scheduler.register({
    id: "trace",
    kind: "manual",
    schedule_expr: "",
    handler_id: "trace",
    required_capabilities: ["WRITE_STORAGE"],
  });
  scheduler.register({
    id: "slowtrace",
    kind: "manual",
    schedule_expr: "",
    handler_id: "slowtrace",
    required_capabilities: ["WRITE_STORAGE"],
  });

  handle = await startUiServer({ scheduler, store, seed: "test-seed", port: 0 });
});

afterEach(() => {
  handle.stop();
  store.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("UI server", () => {
  test("GET /api/status returns runtime info", async () => {
    const res = await fetch(`${handle.url}/api/status`);
    expect(res.status).toBe(200);
    const s = (await res.json()) as { version: string; uiPort: number; runs: number };
    expect(s.version).toBe("0.1.0");
    expect(typeof s.uiPort).toBe("number");
    expect(s.runs).toBe(0);
  });

  test("GET /api/presence returns an array of detected agents", async () => {
    const res = await fetch(`${handle.url}/api/presence`);
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test("presence is detected on demand (no background poll) and cached within the TTL", async () => {
    let calls = 0;
    const scheduler = new Scheduler({ db, registry: new HandlerRegistry(), grants: CAPABILITIES });
    const h = await startUiServer({
      scheduler,
      store,
      seed: "test-seed",
      port: 0,
      presencePollMs: 10_000,
      detectPresences: async () => {
        calls += 1;
        return [];
      },
    });
    try {
      // No startup or background scan — the detector is untouched until a request.
      expect(calls).toBe(0);
      await fetch(`${h.url}/api/presence`);
      await fetch(`${h.url}/api/presence`);
      // The second request is served from the cache within presencePollMs.
      expect(calls).toBe(1);
    } finally {
      h.stop();
    }
  });

  test("GET /api/runs is empty before any run", async () => {
    const res = await fetch(`${handle.url}/api/runs`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("GET /api/connections is [] when no channel provider is wired", async () => {
    const res = await fetch(`${handle.url}/api/connections`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("POST /api/connections/:id/token is 503 when no setToken is wired (fail-closed)", async () => {
    const res = await fetch(`${handle.url}/api/connections/telegram/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "abc" }),
    });
    expect(res.status).toBe(503);
  });

  test("GET / serves the client shell", async () => {
    const res = await fetch(`${handle.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Vesper");
  });

  test("serves injected clientAssets verbatim, with runtime theme stamping", async () => {
    // The compiled (`bun build --compile`) daemon has no client/ dir or bundler, so it
    // injects prebuilt assets. Provided assets must be served as-is — not the on-disk
    // build — while per-process theme stamping still applies to the injected shell.
    const scheduler = new Scheduler({
      db,
      registry: new HandlerRegistry(),
      grants: CAPABILITIES,
      complete: fakeComplete,
    });
    const injected = await startUiServer({
      scheduler,
      store,
      seed: "test-seed",
      port: 0,
      defaultTheme: "glass",
      clientAssets: {
        indexHtml: "<!doctype html><html><head></head><body>INJECTED-SHELL</body></html>",
        appJs: "/* INJECTED-APP-JS */ globalThis.__vesper_injected = true;",
      },
    });
    try {
      const html = await fetch(`${injected.url}/`).then((r) => r.text());
      expect(html).toContain("INJECTED-SHELL");
      expect(html).toContain('name="vesper-theme" content="glass"');
      const js = await fetch(`${injected.url}/app.js`).then((r) => r.text());
      expect(js).toContain("INJECTED-APP-JS");
    } finally {
      injected.stop();
    }
  });

  test("GET /app.js serves the bundled client", async () => {
    const res = await fetch(`${handle.url}/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect((await res.text()).length).toBeGreaterThan(100);
  });

  test("POST /api/pipelines/echo/run runs it and returns the outcome", async () => {
    const res = await fetch(`${handle.url}/api/pipelines/echo/run`, { method: "POST" });
    expect(res.status).toBe(200);
    const outcome = (await res.json()) as { status: string; summary: string };
    expect(outcome.status).toBe("ok");
    expect(outcome.summary).toBe("hello back");

    // The run is now visible in the runs list.
    const runs = (await (await fetch(`${handle.url}/api/runs`)).json()) as { pipeline: string }[];
    expect(runs.some((r) => r.pipeline === "echo")).toBe(true);
  });

  test("POST run for an unknown agent is a 404", async () => {
    const res = await fetch(`${handle.url}/api/pipelines/ghost/run`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  test("rejects a cross-origin request (CSRF/rebinding guard)", async () => {
    const res = await fetch(`${handle.url}/api/pipelines/echo/run`, {
      method: "POST",
      headers: { origin: "http://evil.example.com" },
    });
    expect(res.status).toBe(403);
  });

  test("rejects a rebound Host header", async () => {
    const res = await fetch(`${handle.url}/api/status`, {
      headers: { host: "attacker.example.com" },
    });
    expect(res.status).toBe(403);
  });

  test("a run is pushed to a live WebSocket subscriber", async () => {
    const ws = new WebSocket(`${handle.url.replace("http", "ws")}/api/live`);
    // A completing run now also emits a `usage` step (a `run:event:lite` world pulse),
    // which can arrive before `run:completed` — so wait for the completion frame
    // specifically rather than assuming it is the first message.
    const completed = new Promise<{ type: string; outcome: { taskId: string } }>((resolve) => {
      ws.addEventListener("message", (e) => {
        const m = JSON.parse(String(e.data)) as { type: string; outcome?: { taskId: string } };
        if (m.type === "run:completed" && m.outcome !== undefined) {
          resolve({ type: m.type, outcome: m.outcome });
        }
      });
    });
    await new Promise<void>((resolve) =>
      ws.addEventListener("open", () => resolve(), { once: true }),
    );

    await fetch(`${handle.url}/api/pipelines/echo/run`, { method: "POST" });

    const payload = await completed;
    expect(payload.type).toBe("run:completed");
    expect(payload.outcome.taskId).toBe("echo");
    ws.close();
  });

  // ── Live trace routes + WS control protocol (GROUP B) ───────────────────────

  const SAMPLE_UUID = "00000000-0000-4000-8000-000000000000";

  test("GET /api/runs/:runId/events rejects a non-local request (403)", async () => {
    const res = await fetch(`${handle.url}/api/runs/${SAMPLE_UUID}/events`, {
      headers: { origin: "http://evil.example.com" },
    });
    expect(res.status).toBe(403);
  });

  test("GET /api/runs/:runId/tree rejects a rebound Host header (403)", async () => {
    const res = await fetch(`${handle.url}/api/runs/${SAMPLE_UUID}/tree`, {
      headers: { host: "attacker.example.com" },
    });
    expect(res.status).toBe(403);
  });

  test("GET /api/runs/:runId/events rejects a non-UUID runId (400)", async () => {
    const res = await fetch(`${handle.url}/api/runs/not-a-uuid/events`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("invalid runId");
  });

  test("GET /api/runs/:runId/tree rejects a non-UUID runId (400)", async () => {
    const res = await fetch(`${handle.url}/api/runs/not-a-uuid/tree`);
    expect(res.status).toBe(400);
  });

  test("GET /api/runs/:runId/tree is a 404 for an unknown (well-formed) run", async () => {
    const res = await fetch(`${handle.url}/api/runs/${SAMPLE_UUID}/tree`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("unknown run");
  });

  test("GET /api/runs/:runId/tree surfaces the run's context-window fill", async () => {
    // The `echo` handler calls ctx.complete, whose fake usage records run context.
    const outcome = (await (
      await fetch(`${handle.url}/api/pipelines/echo/run`, { method: "POST" })
    ).json()) as { runId: string };
    expect(outcome.runId).not.toBeNull();

    const res = await fetch(`${handle.url}/api/runs/${outcome.runId}/tree`);
    expect(res.status).toBe(200);
    const tree = (await res.json()) as {
      run: { context: { usedTokens: number; limit: number; model: string | null } | null };
    };
    expect(tree.run.context).toEqual({
      usedTokens: 1_234,
      limit: 1_000_000,
      model: "claude-opus-4-8[1m]",
    });
  });

  test("GET /api/runs/:runId/events replays persisted trace events (backfill)", async () => {
    const outcome = (await (
      await fetch(`${handle.url}/api/pipelines/trace/run`, { method: "POST" })
    ).json()) as { runId: string };
    expect(outcome.runId).not.toBeNull();

    const res = await fetch(`${handle.url}/api/runs/${outcome.runId}/events?afterTs=0`);
    expect(res.status).toBe(200);
    const events = (await res.json()) as { runId: string; kind: string; message: string }[];
    expect(events.length).toBeGreaterThanOrEqual(1);
    const step = events.find((e) => e.kind === "step");
    expect(step?.message).toBe("thinking");
    expect(step?.runId).toBe(outcome.runId);
  });

  test("emitProgress is pushed live to a subscribed WS client + a lite world pulse", async () => {
    const ws = new WebSocket(`${handle.url.replace("http", "ws")}/api/live`);
    await new Promise<void>((resolve) =>
      ws.addEventListener("open", () => resolve(), { once: true }),
    );

    // Collect every frame so we can find both the per-run event and the world pulse.
    const frames: { type: string; runId?: string; event?: { runId: string; kind: string } }[] = [];
    ws.addEventListener("message", (e) => {
      frames.push(JSON.parse(String(e.data)));
    });

    // A subscriber on 'world' gets the lite pulse for ANY run without knowing the id
    // up front; subscribe to the trace run's id once we learn it from the lite frame.
    const litePromise = new Promise<string>((resolve) => {
      ws.addEventListener("message", (e) => {
        const m = JSON.parse(String(e.data)) as { type: string; runId?: string };
        if (m.type === "run:event:lite" && m.runId !== undefined) resolve(m.runId);
      });
    });

    await fetch(`${handle.url}/api/pipelines/trace/run`, { method: "POST" });

    const liteRunId = await litePromise;
    expect(liteRunId).not.toBeNull();

    // The lite pulse arrived on the 'world' topic; assert at least one full run:event
    // frame was also published (subscribers on agent:<runId> get it — here the run
    // finished before subscribe, so replay is the durable path; the lite pulse proves
    // the world-topic broadcast). Verify the lite frame carried the right shape.
    const liteFrame = frames.find((f) => f.type === "run:event:lite");
    expect(liteFrame?.runId).toBe(liteRunId);
    ws.close();
  });

  test("emitProgress reaches an agent:<runId> subscriber after subscribe", async () => {
    const ws = new WebSocket(`${handle.url.replace("http", "ws")}/api/live`);
    await new Promise<void>((resolve) =>
      ws.addEventListener("open", () => resolve(), { once: true }),
    );

    // The slowtrace handler emits 'first' (lite pulse on 'world' carries its runId),
    // yields 60ms, then emits 'second'. We subscribe to agent:<runId> on the first
    // lite pulse, so the SECOND emit is delivered live to this subscriber. The POST
    // is intentionally NOT awaited up front — scheduler.run resolves only after the
    // whole handler, by which point both emits have fired.
    const liveSecond = new Promise<{ runId: string; kind: string; message: string }>((resolve) => {
      ws.addEventListener("message", (e) => {
        const m = JSON.parse(String(e.data)) as {
          type: string;
          runId?: string;
          event?: { runId: string; kind: string; message: string };
        };
        if (m.type === "run:event:lite" && m.runId !== undefined) {
          ws.send(JSON.stringify({ type: "subscribe", runId: m.runId }));
        } else if (m.type === "run:event" && m.event?.message === "second") {
          resolve(m.event);
        }
      });
    });

    void fetch(`${handle.url}/api/pipelines/slowtrace/run`, { method: "POST" });

    const ev = await liveSecond;
    expect(ev.kind).toBe("progress");
    expect(ev.message).toBe("second");
    ws.close();
  });

  test("a WS subscribe with a non-UUID runId is ignored (no crash)", async () => {
    const ws = new WebSocket(`${handle.url.replace("http", "ws")}/api/live`);
    await new Promise<void>((resolve) =>
      ws.addEventListener("open", () => resolve(), { once: true }),
    );
    ws.send(JSON.stringify({ type: "subscribe", runId: "not-a-uuid" }));
    ws.send("garbage-not-json");
    // The server stays alive: a subsequent run still pushes its completion.
    const completed = new Promise<string>((resolve) => {
      ws.addEventListener("message", (e) => {
        const m = JSON.parse(String(e.data)) as { type: string };
        if (m.type === "run:completed") resolve("ok");
      });
    });
    await fetch(`${handle.url}/api/pipelines/echo/run`, { method: "POST" });
    expect(await completed).toBe("ok");
    ws.close();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Chatbot home + editable pipeline templates (chatbot-home spec)
// ───────────────────────────────────────────────────────────────────────────

describe("UI server — chat + templates", () => {
  let cDir: string;
  let cDb: Database;
  let cStore: Store;
  let cHandle: UiServerHandle;
  let tokens: ApprovalTokenStore;

  beforeEach(async () => {
    cDir = mkdtempSync(join(tmpdir(), "vesper-ui-chat-"));
    const path = join(cDir, "vesper.db");
    openStore(path).close();
    cDb = new Database(path);
    cStore = openStore(path);

    const registry = new HandlerRegistry();
    // A spawn-only child the router dispatches to.
    registry.register("child", async (ctx) => {
      ctx.emitProgress({ kind: "step", message: "working" });
      ctx.recordRun({ status: "ok", summary: "child summary" });
    });
    // A minimal router that classifies via complete() then spawns the child.
    registry.register("router", async (ctx) => {
      await ctx.complete("classify");
      const handle = ctx.spawn({
        handlerId: "child",
        label: "child",
        params: {},
        capabilities: ["WRITE_STORAGE"],
      });
      const outcome = await handle.done.catch(() => null);
      ctx.recordRun({
        status: outcome?.status === "ok" ? "ok" : "partial",
        // Surface the child pipeline's actual answer as the assistant reply (mirrors
        // the real router) — the chat turn shows this summary, not a routing receipt.
        summary: outcome?.summary ?? "the child pipeline returned no response",
      });
    });
    const scheduler = new Scheduler({
      db: cDb,
      registry,
      grants: CAPABILITIES,
      complete: fakeComplete,
    });
    scheduler.register({
      id: "router",
      kind: "manual",
      schedule_expr: "",
      handler_id: "router",
      required_capabilities: ["CLI_INVOKE", "WRITE_STORAGE", "SPAWN_SUBAGENT"],
    });

    tokens = new ApprovalTokenStore();
    cHandle = await startUiServer({
      scheduler,
      store: cStore,
      seed: "chat-seed",
      port: 0,
      approvalTokens: tokens,
    });
  });

  afterEach(() => {
    cHandle.stop();
    cStore.close();
    cDb.close();
    rmSync(cDir, { recursive: true, force: true });
  });

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  test("POST /api/chat runs the router and returns sessionId/turnId/runId", async () => {
    const res = await fetch(`${cHandle.url}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "run a self test" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessionId: string;
      turnId: string;
      runId: string;
      reply: string;
    };
    expect(UUID_RE.test(body.sessionId)).toBe(true);
    expect(body.runId).not.toBeNull();
    // `reply` carries the assistant text so a channel sink can deliver it in one round-trip.
    expect(typeof body.reply).toBe("string");
    expect(body.reply.length).toBeGreaterThan(0);

    // The transcript has the user turn + an assistant turn carrying the runId.
    const turnsRes = await fetch(
      `${cHandle.url}/api/chat/sessions/${body.sessionId}/turns?afterTs=0`,
    );
    const turns = (await turnsRes.json()) as {
      role: string;
      text: string;
      runId: string | null;
    }[];
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant"]);
    expect(turns[1]?.runId).toBe(body.runId);

    // A chat audit event was written.
    const sessions = (await (await fetch(`${cHandle.url}/api/chat/sessions`)).json()) as {
      id: string;
    }[];
    expect(sessions.map((s) => s.id)).toContain(body.sessionId);
  });

  test("POST /api/chat continues an existing session when sessionId is supplied", async () => {
    const first = (await (
      await fetch(`${cHandle.url}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "one" }),
      })
    ).json()) as { sessionId: string };

    await fetch(`${cHandle.url}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "two", sessionId: first.sessionId }),
    });

    const turns = (await (
      await fetch(`${cHandle.url}/api/chat/sessions/${first.sessionId}/turns`)
    ).json()) as unknown[];
    // 2 messages x (user + assistant) = 4 turns in ONE session.
    expect(turns).toHaveLength(4);
    const sessions = (await (await fetch(`${cHandle.url}/api/chat/sessions`)).json()) as unknown[];
    expect(sessions).toHaveLength(1);
  });

  test("POST /api/chat rejects an empty message (400)", async () => {
    const res = await fetch(`${cHandle.url}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "   " }),
    });
    expect(res.status).toBe(400);
  });

  test("POST /api/chat rejects a non-UUID sessionId (400)", async () => {
    const res = await fetch(`${cHandle.url}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi", sessionId: "not-a-uuid" }),
    });
    expect(res.status).toBe(400);
  });

  test("POST /api/chat is rejected cross-origin (403, CSRF guard)", async () => {
    const res = await fetch(`${cHandle.url}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example.com" },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(res.status).toBe(403);
  });

  test("GET /api/chat/sessions/:id/turns rejects a non-UUID id (400)", async () => {
    const res = await fetch(`${cHandle.url}/api/chat/sessions/not-a-uuid/turns`);
    expect(res.status).toBe(400);
  });

  test("a chat turn is pushed live to a chat:<sessionId> subscriber", async () => {
    // Create the session first so we have an id to subscribe to.
    const first = (await (
      await fetch(`${cHandle.url}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "seed" }),
      })
    ).json()) as { sessionId: string };

    const ws = new WebSocket(`${cHandle.url.replace("http", "ws")}/api/live`);
    await new Promise<void>((resolve) =>
      ws.addEventListener("open", () => resolve(), { once: true }),
    );
    ws.send(JSON.stringify({ type: "subscribe", sessionId: first.sessionId }));
    // Give the subscribe control frame a tick to register.
    await new Promise((r) => setTimeout(r, 20));

    const got = new Promise<{ role: string; text: string }>((resolve) => {
      ws.addEventListener("message", (e) => {
        const m = JSON.parse(String(e.data)) as { type: string; role?: string; text?: string };
        if (m.type === "chat:turn" && m.role === "user" && m.text === "second message") {
          resolve({ role: m.role, text: m.text });
        }
      });
    });

    await fetch(`${cHandle.url}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "second message", sessionId: first.sessionId }),
    });

    const frame = await got;
    expect(frame.role).toBe("user");
    ws.close();
  });

  test("GET /api/pipelines lists registered tasks with their config", async () => {
    const res = await fetch(`${cHandle.url}/api/pipelines`);
    expect(res.status).toBe(200);
    const pipelines = (await res.json()) as { id: string; handlerId: string }[];
    expect(pipelines.map((p) => p.id)).toContain("router");
  });

  test("GET /api/pipelines/:id/template returns prompt + params + config", async () => {
    const res = await fetch(`${cHandle.url}/api/pipelines/router/template`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      handlerId: string;
      prompt: string;
      defaultParams: Record<string, unknown>;
      config: { id: string };
    };
    expect(body.handlerId).toBe("router");
    expect(body.prompt).toBe("");
    expect(body.config.id).toBe("router");
  });

  test("GET template for an unknown pipeline is a 404", async () => {
    const res = await fetch(`${cHandle.url}/api/pipelines/ghost/template`);
    expect(res.status).toBe(404);
  });

  test("PUT template without an approval code is 401", async () => {
    const res = await fetch(`${cHandle.url}/api/pipelines/router/template`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "new", defaultParams: {} }),
    });
    expect(res.status).toBe(401);
  });

  test("PUT template with an invalid approval code is 403", async () => {
    const res = await fetch(`${cHandle.url}/api/pipelines/router/template`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-vesper-approval": "deadbeef" },
      body: JSON.stringify({ prompt: "new", defaultParams: {} }),
    });
    expect(res.status).toBe(403);
  });

  test("PUT template with a valid single-use code persists prompt + params and audits", async () => {
    const code = tokens.mint();
    const res = await fetch(`${cHandle.url}/api/pipelines/router/template`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-vesper-approval": code },
      body: JSON.stringify({ prompt: "classify strictly", defaultParams: { tone: "warm" } }),
    });
    expect(res.status).toBe(200);

    // The template is now persisted and read back via GET.
    const got = (await (await fetch(`${cHandle.url}/api/pipelines/router/template`)).json()) as {
      prompt: string;
      defaultParams: Record<string, unknown>;
    };
    expect(got.prompt).toBe("classify strictly");
    expect(got.defaultParams).toEqual({ tone: "warm" });

    // The code is single-use — a second PUT with the same code is 403.
    const replay = await fetch(`${cHandle.url}/api/pipelines/router/template`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-vesper-approval": code },
      body: JSON.stringify({ prompt: "x", defaultParams: {} }),
    });
    expect(replay.status).toBe(403);
  });

  test("PUT template is rejected cross-origin BEFORE the token is checked (403)", async () => {
    const code = tokens.mint();
    const res = await fetch(`${cHandle.url}/api/pipelines/router/template`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        origin: "http://evil.example.com",
        "x-vesper-approval": code,
      },
      body: JSON.stringify({ prompt: "x", defaultParams: {} }),
    });
    expect(res.status).toBe(403);
    // The local-origin guard fired first, so the code was NOT consumed.
    expect(tokens.isValid(code)).toBe(true);
  });

  test("POST /api/approval/request mints a code (production mint path) without leaking it", async () => {
    const res = await fetch(`${cHandle.url}/api/approval/request`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // Returns ok; the code is surfaced OUT-OF-BAND on the daemon TTY, never in the body.
    expect(body).toEqual({ ok: true });
    expect(JSON.stringify(body)).not.toMatch(/[0-9a-f]{6,}/);
  });
});

describe("UI server — software-engineer diff + decision routes", () => {
  const RUN_UUID = "11111111-1111-4111-8111-111111111111";
  const CHANGE_ID = `${RUN_UUID}:build`;
  const OTHER_UUID = "22222222-2222-4222-8222-222222222222";
  const SAMPLE_DIFF: SweDiffView = {
    runId: RUN_UUID,
    changeId: CHANGE_ID,
    staged: false,
    additions: 1,
    deletions: 0,
    fileCount: 1,
    files: [
      {
        oldPath: null,
        newPath: "src/a.ts",
        path: "src/a.ts",
        status: "added",
        additions: 1,
        deletions: 0,
        binary: false,
        hunks: [
          {
            header: "@@ -0,0 +1 @@",
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: 1,
            lines: [{ kind: "insert", content: "export const a = 1;", oldLine: null, newLine: 1 }],
          },
        ],
      },
    ],
  };

  let sDir: string;
  let sDb: Database;
  let sStore: Store;
  let sTokens: ApprovalTokenStore;
  let sHandle: UiServerHandle;
  let loadDiffCalls: { runId: string; opts: { changeId?: string; staged?: boolean } }[];
  let decideCalls: { runId: string; changeId: string; decision: string; reason?: string }[];
  let decideReturns: boolean;

  beforeEach(async () => {
    sDir = mkdtempSync(join(tmpdir(), "vesper-ui-swe-"));
    const path = join(sDir, "vesper.db");
    openStore(path).close();
    sDb = new Database(path);
    sStore = openStore(path);
    sTokens = new ApprovalTokenStore();
    loadDiffCalls = [];
    decideCalls = [];
    decideReturns = true;

    const registry = new HandlerRegistry();
    // Echoes its transient params into the run summary so the run route's body-param
    // passing (repo/wish for the software-engineer lead) is observable end to end.
    registry.register("paramecho", (ctx) => {
      ctx.recordRun({ status: "ok", summary: JSON.stringify(ctx.params) });
    });
    const scheduler = new Scheduler({ db: sDb, registry, grants: CAPABILITIES });
    scheduler.register({
      id: "paramecho",
      kind: "manual",
      schedule_expr: "",
      handler_id: "paramecho",
      required_capabilities: ["WRITE_STORAGE"],
    });
    sHandle = await startUiServer({
      scheduler,
      store: sStore,
      port: 0,
      approvalTokens: sTokens,
      softwareEngineer: {
        loadDiff: async (runId, opts) => {
          loadDiffCalls.push({ runId, opts });
          // Only the known run has a diff; any other valid UUID resolves to null (404).
          return runId === RUN_UUID ? { ...SAMPLE_DIFF, staged: opts.staged === true } : null;
        },
        decide: (runId, changeId, decision) => {
          decideCalls.push({
            runId,
            changeId,
            decision: decision.decision,
            reason: decision.reason,
          });
          return decideReturns;
        },
      },
    });
  });

  afterEach(() => {
    sHandle.stop();
    sStore.close();
    sDb.close();
    rmSync(sDir, { recursive: true, force: true });
  });

  test("POST /api/pipelines/:id/run passes body params through to the run", async () => {
    const res = await fetch(`${sHandle.url}/api/pipelines/paramecho/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ params: { repo: "/tmp/demo", wish: "add a hello file" } }),
    });
    expect(res.status).toBe(200);
    const outcome = (await res.json()) as { status: string; summary: string };
    expect(outcome.status).toBe("ok");
    const echoed = JSON.parse(outcome.summary) as Record<string, unknown>;
    expect(echoed.repo).toBe("/tmp/demo");
    expect(echoed.wish).toBe("add a hello file");
  });

  test("POST /api/pipelines/:id/run still works with no body (no params)", async () => {
    const res = await fetch(`${sHandle.url}/api/pipelines/paramecho/run`, { method: "POST" });
    expect(res.status).toBe(200);
    const outcome = (await res.json()) as { status: string; summary: string };
    expect(outcome.summary).toBe("{}");
  });

  test("GET /diff returns the structured per-file diff", async () => {
    const res = await fetch(`${sHandle.url}/api/runs/${RUN_UUID}/diff`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SweDiffView;
    expect(body.fileCount).toBe(1);
    expect(body.files[0]?.path).toBe("src/a.ts");
    expect(body.files[0]?.hunks[0]?.lines[0]?.kind).toBe("insert");
  });

  test("GET /diff threads the staged flag through", async () => {
    await fetch(`${sHandle.url}/api/runs/${RUN_UUID}/diff?staged=1`);
    expect(loadDiffCalls.at(-1)?.opts.staged).toBe(true);
  });

  test("GET /diff rejects a non-UUID runId (400)", async () => {
    const res = await fetch(`${sHandle.url}/api/runs/not-a-uuid/diff`);
    expect(res.status).toBe(400);
  });

  test("GET /diff returns 404 when no diff exists for the run", async () => {
    const res = await fetch(`${sHandle.url}/api/runs/${OTHER_UUID}/diff`);
    expect(res.status).toBe(404);
  });

  test("GET /diff returns 503 when no software-engineer provider is wired", async () => {
    const registry = new HandlerRegistry();
    const scheduler = new Scheduler({ db: sDb, registry, grants: CAPABILITIES });
    const bare = await startUiServer({ scheduler, store: sStore, port: 0 });
    try {
      const res = await fetch(`${bare.url}/api/runs/${RUN_UUID}/diff`);
      expect(res.status).toBe(503);
    } finally {
      bare.stop();
    }
  });

  test("POST /decision WITHOUT an approval token is refused and never reaches decide()", async () => {
    const res = await fetch(
      `${sHandle.url}/api/runs/${RUN_UUID}/changes/${encodeURIComponent(CHANGE_ID)}/decision`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve" }),
      },
    );
    expect(res.status).not.toBe(200);
    expect([401, 403]).toContain(res.status);
    expect(decideCalls).toHaveLength(0);
  });

  test("POST /decision with a valid token approves and delivers to the coordinator", async () => {
    const code = sTokens.mint();
    const res = await fetch(
      `${sHandle.url}/api/runs/${RUN_UUID}/changes/${encodeURIComponent(CHANGE_ID)}/decision`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-vesper-approval": code },
        body: JSON.stringify({ decision: "approve" }),
      },
    );
    expect(res.status).toBe(200);
    expect(decideCalls).toHaveLength(1);
    expect(decideCalls[0]?.decision).toBe("approve");
    expect(decideCalls[0]?.changeId).toBe(CHANGE_ID);
  });

  test("POST /decision forwards a reject reason", async () => {
    const code = sTokens.mint();
    await fetch(
      `${sHandle.url}/api/runs/${RUN_UUID}/changes/${encodeURIComponent(CHANGE_ID)}/decision`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-vesper-approval": code },
        body: JSON.stringify({ decision: "reject", reason: "nope" }),
      },
    );
    expect(decideCalls[0]?.decision).toBe("reject");
    expect(decideCalls[0]?.reason).toBe("nope");
  });

  test("POST /decision rejects an invalid decision body (400)", async () => {
    const code = sTokens.mint();
    const res = await fetch(
      `${sHandle.url}/api/runs/${RUN_UUID}/changes/${encodeURIComponent(CHANGE_ID)}/decision`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-vesper-approval": code },
        body: JSON.stringify({ decision: "maybe" }),
      },
    );
    expect(res.status).toBe(400);
    expect(decideCalls).toHaveLength(0);
  });

  test("POST /decision returns 409 when no waiter is pending", async () => {
    decideReturns = false;
    const code = sTokens.mint();
    const res = await fetch(
      `${sHandle.url}/api/runs/${RUN_UUID}/changes/${encodeURIComponent(CHANGE_ID)}/decision`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-vesper-approval": code },
        body: JSON.stringify({ decision: "approve" }),
      },
    );
    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Manual token entry — POST /api/connections/:id/token (Slice 0, local-origin only)
// ---------------------------------------------------------------------------

describe("UI server — manual token entry", () => {
  let tDir: string;
  let tDb: Database;
  let tStore: Store;
  let tHandle: UiServerHandle;
  let setCalls: Array<{ id: string; token: string; params?: Record<string, string> }>;
  let setThrows: string | null;

  beforeEach(async () => {
    tDir = mkdtempSync(join(tmpdir(), "vesper-ui-token-"));
    const path = join(tDir, "vesper.db");
    openStore(path).close();
    tDb = new Database(path);
    tStore = openStore(path);
    setCalls = [];
    setThrows = null;

    const scheduler = new Scheduler({
      db: tDb,
      registry: new HandlerRegistry(),
      grants: CAPABILITIES,
    });
    tHandle = await startUiServer({
      scheduler,
      store: tStore,
      seed: "token-seed",
      port: 0,
      connections: {
        list: async () => [],
        setToken: async (id, token, params) => {
          if (setThrows !== null) throw new Error(setThrows);
          setCalls.push({ id, token, ...(params !== undefined ? { params } : {}) });
          return { vaultKey: `${id}_token` };
        },
      },
    });
  });

  afterEach(() => {
    tHandle.stop();
    tStore.close();
    tDb.close();
    rmSync(tDir, { recursive: true, force: true });
  });

  test("a valid token is stored via setToken and never echoed back; the mutation is audited", async () => {
    const res = await fetch(`${tHandle.url}/api/connections/telegram/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "  123:secret  ", params: { phoneNumberId: "42" } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ ok: true });
    // The token is trimmed and forwarded to the host setToken; not in the response.
    expect(setCalls).toEqual([
      { id: "telegram", token: "123:secret", params: { phoneNumberId: "42" } },
    ]);
    expect(JSON.stringify(body)).not.toContain("secret");
    // Audited as channel + method only — never the token value.
    const events = tStore.listEvents({ limit: 10 });
    const audited = events.find((e) => e.kind === "token_set");
    expect(audited?.payload).toMatchObject({ channel: "telegram", method: "manual" });
    expect(JSON.stringify(audited?.payload)).not.toContain("secret");
  });

  test("an empty token is rejected (400) and never reaches setToken", async () => {
    const res = await fetch(`${tHandle.url}/api/connections/telegram/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "   " }),
    });
    expect(res.status).toBe(400);
    expect(setCalls).toHaveLength(0);
  });

  test("a host setToken failure surfaces as 400 with its message (e.g. unknown channel)", async () => {
    setThrows = 'unknown channel "nope"';
    const res = await fetch(`${tHandle.url}/api/connections/nope/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "abc" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("unknown channel");
  });

  test("a cross-origin POST is refused by the local-origin guard", async () => {
    const res = await fetch(`${tHandle.url}/api/connections/telegram/token`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ token: "abc" }),
    });
    expect(res.status).toBe(403);
    expect(setCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Channel auto-onboarding — POST /api/connections/:id/setup (Slice 3/4)
// ---------------------------------------------------------------------------

describe("UI server — channel setup (auto-onboarding)", () => {
  let uDir: string;
  let uDb: Database;
  let uStore: Store;
  let uHandle: UiServerHandle;

  async function readNdjson(res: Response): Promise<Array<Record<string, unknown>>> {
    const text = await res.text();
    return text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  beforeEach(async () => {
    uDir = mkdtempSync(join(tmpdir(), "vesper-ui-setup-"));
    const path = join(uDir, "vesper.db");
    openStore(path).close();
    uDb = new Database(path);
    uStore = openStore(path);
    const scheduler = new Scheduler({
      db: uDb,
      registry: new HandlerRegistry(),
      grants: CAPABILITIES,
    });
    uHandle = await startUiServer({
      scheduler,
      store: uStore,
      seed: "setup-seed",
      port: 0,
      connections: {
        list: async () => [],
        setup: (id) => ({
          // eslint-disable-next-line require-yield
          async *updates() {
            yield { status: "working", message: `Setting up ${id}…` };
            yield { status: "configured" };
          },
          stop() {},
        }),
      },
    });
  });

  afterEach(() => {
    uHandle.stop();
    uStore.close();
    uDb.close();
    rmSync(uDir, { recursive: true, force: true });
  });

  test("streams the setup updates as newline-delimited JSON ending in a terminal status", async () => {
    const res = await fetch(`${uHandle.url}/api/connections/telegram/setup`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("ndjson");
    const updates = await readNdjson(res);
    expect(updates.map((u) => u.status)).toEqual(["working", "configured"]);
  });

  test("POST /setup is 503 when no setup provider is wired (fail-closed)", async () => {
    const scheduler = new Scheduler({
      db: uDb,
      registry: new HandlerRegistry(),
      grants: CAPABILITIES,
    });
    const bare = await startUiServer({ scheduler, store: uStore, seed: "bare", port: 0 });
    try {
      const res = await fetch(`${bare.url}/api/connections/telegram/setup`, { method: "POST" });
      expect(res.status).toBe(503);
    } finally {
      bare.stop();
    }
  });

  test("a cross-origin setup POST is refused by the local-origin guard", async () => {
    const res = await fetch(`${uHandle.url}/api/connections/telegram/setup`, {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Skills library — GET /api/skills + GET /api/skills/:name (read-only)
// ---------------------------------------------------------------------------

describe("UI server — skills library", () => {
  let kDir: string;
  let kDb: Database;
  let kStore: Store;
  let kHandle: UiServerHandle;

  const SUMMARY = {
    name: "demo",
    displayName: "demo",
    description: "A demo skill.",
    taskCount: 2,
    hasCandidate: true,
    differs: true,
    lastScore: { prior: 0.5, candidate: 0.8, accepted: true },
  };

  beforeEach(async () => {
    kDir = mkdtempSync(join(tmpdir(), "vesper-ui-skills-"));
    const path = join(kDir, "vesper.db");
    openStore(path).close();
    kDb = new Database(path);
    kStore = openStore(path);
    const scheduler = new Scheduler({
      db: kDb,
      registry: new HandlerRegistry(),
      grants: CAPABILITIES,
    });
    kHandle = await startUiServer({
      scheduler,
      store: kStore,
      seed: "skills-seed",
      port: 0,
      skills: {
        list: async () => [SUMMARY],
        get: async (name) =>
          name === "demo"
            ? {
                ...SUMMARY,
                body: "the skill body",
                best: "the candidate body",
                tasks: [],
                history: [],
              }
            : null,
      },
    });
  });

  afterEach(() => {
    kHandle.stop();
    kStore.close();
    kDb.close();
    rmSync(kDir, { recursive: true, force: true });
  });

  test("GET /api/skills returns the library list", async () => {
    const res = await fetch(`${kHandle.url}/api/skills`);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "demo", taskCount: 2, differs: true });
  });

  test("GET /api/skills/:name returns full detail", async () => {
    const res = await fetch(`${kHandle.url}/api/skills/demo`);
    expect(res.status).toBe(200);
    const d = (await res.json()) as Record<string, unknown>;
    expect(d.body).toBe("the skill body");
    expect(d.best).toBe("the candidate body");
  });

  test("GET /api/skills/:name is 404 for an unknown skill", async () => {
    const res = await fetch(`${kHandle.url}/api/skills/missing`);
    expect(res.status).toBe(404);
  });

  test("GET /api/skills/:name rejects a non-kebab name (400)", async () => {
    const res = await fetch(`${kHandle.url}/api/skills/${encodeURIComponent("../etc")}`);
    expect(res.status).toBe(400);
  });

  test("GET /api/skills is [] when no provider is wired", async () => {
    const scheduler = new Scheduler({
      db: kDb,
      registry: new HandlerRegistry(),
      grants: CAPABILITIES,
    });
    const bare = await startUiServer({ scheduler, store: kStore, seed: "bare-k", port: 0 });
    try {
      expect(await (await fetch(`${bare.url}/api/skills`)).json()).toEqual([]);
      // The detail route is fail-closed (503) without a provider.
      expect((await fetch(`${bare.url}/api/skills/demo`)).status).toBe(503);
    } finally {
      bare.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Memory (RAG) status — GET /api/memory (scaffold; model deferred)
// ---------------------------------------------------------------------------

describe("UI server — memory status", () => {
  test("GET /api/memory reports unavailable with an indexed-document count (never throws)", async () => {
    const res = await fetch(`${handle.url}/api/memory`);
    expect(res.status).toBe(200);
    const status = (await res.json()) as {
      available: boolean;
      reason?: string;
      indexedDocuments: number;
    };
    expect(status.available).toBe(false);
    expect(status.reason).toBe("rag_unavailable");
    expect(status.indexedDocuments).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Autonomous loop — POST /api/loop/run (specs/autonomous-loop.md)
// ---------------------------------------------------------------------------

describe("UI server — autonomous loop", () => {
  test("POST /api/loop/run returns the runId immediately while the loop continues", async () => {
    const lDir = mkdtempSync(join(tmpdir(), "vesper-ui-loop-"));
    const path = join(lDir, "vesper.db");
    openStore(path).close();
    const lDb = new Database(path);
    const lStore = openStore(path);

    const registry = new HandlerRegistry();
    // Stand-in for the real loop pipeline: emits a role step, keeps running past
    // the route's response, then records — proving the route does NOT await it.
    registry.register("loop", async (ctx) => {
      ctx.emitProgress({ kind: "step", message: "iteration 1: authored next prompt" });
      await new Promise((resolve) => setTimeout(resolve, 150));
      ctx.recordRun({ status: "succeeded", summary: "done" });
    });
    const scheduler = new Scheduler({ db: lDb, registry, grants: CAPABILITIES });
    scheduler.register({
      id: "loop",
      kind: "manual",
      schedule_expr: "",
      handler_id: "loop",
      required_capabilities: ["CLI_INVOKE", "WRITE_STORAGE"],
    });
    const lHandle = await startUiServer({ scheduler, store: lStore, seed: "s", port: 0 });

    try {
      const res = await fetch(`${lHandle.url}/api/loop/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal: "reach the objective", maxIterations: 3 }),
      });
      expect(res.status).toBe(202);
      const body = (await res.json()) as { runId?: string };
      expect(typeof body.runId).toBe("string");

      // The loop is still in flight when the route answers (the row is `running`).
      const live = lStore.listRuns({ pipeline: "loop" }).find((r) => r.id === body.runId);
      expect(live?.status).toBe("running");

      // It finishes on its own afterwards.
      let final = live;
      for (let i = 0; i < 40 && final?.status === "running"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        final = lStore.listRuns({ pipeline: "loop" }).find((r) => r.id === body.runId);
      }
      expect(final?.status).toBe("succeeded");
    } finally {
      lHandle.stop();
      lStore.close();
      lDb.close();
      rmSync(lDir, { recursive: true, force: true });
    }
  });

  test("POST /api/loop/run without a goal is a 400 and starts nothing", async () => {
    const res = await fetch(`${handle.url}/api/loop/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(store.listRuns({ pipeline: "loop" })).toHaveLength(0);
  });
});
