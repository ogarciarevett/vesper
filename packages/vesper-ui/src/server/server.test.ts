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
  const scheduler = new Scheduler({ db, registry, grants: CAPABILITIES, complete: fakeComplete });
  scheduler.register({
    id: "echo",
    kind: "manual",
    schedule_expr: "",
    handler_id: "echo",
    required_capabilities: ["CLI_INVOKE", "WRITE_STORAGE"],
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
});
