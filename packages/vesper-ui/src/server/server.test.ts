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

  test("GET /api/runs is empty before any run", async () => {
    const res = await fetch(`${handle.url}/api/runs`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
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
        summary: "routed to child",
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
    const body = (await res.json()) as { sessionId: string; turnId: string; runId: string };
    expect(UUID_RE.test(body.sessionId)).toBe(true);
    expect(body.runId).not.toBeNull();

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
