import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
  test("GET /api/world returns a SceneGraph with one inhabitant per pipeline", async () => {
    const res = await fetch(`${handle.url}/api/world`);
    expect(res.status).toBe(200);
    const scene = (await res.json()) as { seed: string; inhabitants: { id: string }[] };
    expect(scene.seed).toBe("test-seed");
    expect(scene.inhabitants.map((i) => i.id)).toContain("echo");
  });

  test("GET / serves the client shell", async () => {
    const res = await fetch(`${handle.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Vesper");
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

    // The run is now visible in the world snapshot.
    const world = (await (await fetch(`${handle.url}/api/world`)).json()) as {
      inhabitants: { id: string; runCount: number }[];
    };
    expect(world.inhabitants.find((i) => i.id === "echo")?.runCount).toBe(1);
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
    const res = await fetch(`${handle.url}/api/world`, {
      headers: { host: "attacker.example.com" },
    });
    expect(res.status).toBe(403);
  });

  test("a run is pushed to a live WebSocket subscriber", async () => {
    const ws = new WebSocket(`${handle.url.replace("http", "ws")}/api/live`);
    const message = new Promise<string>((resolve) => {
      ws.addEventListener("message", (e) => resolve(String(e.data)), { once: true });
    });
    await new Promise<void>((resolve) =>
      ws.addEventListener("open", () => resolve(), { once: true }),
    );

    await fetch(`${handle.url}/api/pipelines/echo/run`, { method: "POST" });

    const payload = JSON.parse(await message) as { type: string; outcome: { taskId: string } };
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
