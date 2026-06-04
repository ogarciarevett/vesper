import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAPABILITIES,
  type CompleteFn,
  HandlerRegistry,
  openStore,
  type PairingSession,
  type PairingUpdate,
  Scheduler,
} from "@vesper/core";
import { startUiServer, type UiServerHandle } from "./server.ts";

const fakeComplete: CompleteFn = async () => ({
  text: "pong",
  exit_code: 0,
  raw_stdout: "pong",
  raw_stderr: "",
  duration_ms: 1,
  usage: {
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    model: "test",
  },
});

interface PairingProvider {
  startPairing(channelId: string): Promise<PairingSession>;
}

function fakePairing(updates: readonly PairingUpdate[]): PairingProvider {
  return {
    startPairing: async (): Promise<PairingSession> => ({
      updates: async function* () {
        for (const u of updates) yield u;
      },
      stop() {},
    }),
  };
}

const cleanups: Array<() => void> = [];

async function startServer(pairing?: PairingProvider): Promise<UiServerHandle> {
  const dir = mkdtempSync(join(tmpdir(), "vesper-pair-"));
  const path = join(dir, "vesper.db");
  openStore(path).close(); // migrate
  const db = new Database(path);
  const store = openStore(path);
  const scheduler = new Scheduler({
    db,
    registry: new HandlerRegistry(),
    grants: CAPABILITIES,
    complete: fakeComplete,
  });
  const handle = await startUiServer({
    scheduler,
    store,
    port: 0,
    ...(pairing !== undefined ? { pairing } : {}),
  });
  cleanups.push(() => {
    handle.stop();
    db.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return handle;
}

afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

test("POST /api/connections/:id/pair streams ndjson PairingUpdates to a terminal status", async () => {
  const handle = await startServer(
    fakePairing([
      {
        status: "awaiting",
        prompt: {
          kind: "link",
          data: "https://t.me/vesperbot?start=abc",
          humanHint: "scan me",
          expiresAt: 1,
        },
      },
      { status: "linked", chatId: "42", label: "omar" },
    ]),
  );
  const res = await fetch(`${handle.url}/api/connections/telegram/pair`, {
    method: "POST",
    headers: { origin: handle.url },
  });
  expect(res.ok).toBe(true);
  expect(res.headers.get("content-type")).toContain("x-ndjson");
  const lines = (await res.text())
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as PairingUpdate);
  expect(lines[0]).toMatchObject({ status: "awaiting" });
  expect(lines.at(-1)).toMatchObject({ status: "linked", chatId: "42" });
});

test("POST /api/connections/:id/pair returns 503 when no pairing provider is wired", async () => {
  const handle = await startServer();
  const res = await fetch(`${handle.url}/api/connections/telegram/pair`, {
    method: "POST",
    headers: { origin: handle.url },
  });
  expect(res.status).toBe(503);
});

test("GET /api/qr returns a square QR matrix for a link", async () => {
  const handle = await startServer();
  const res = await fetch(
    `${handle.url}/api/qr?data=${encodeURIComponent("https://t.me/vesperbot?start=abc")}`,
    { headers: { origin: handle.url } },
  );
  expect(res.ok).toBe(true);
  const matrix = (await res.json()) as { size: number; modules: boolean[] };
  expect(matrix.size).toBeGreaterThan(0);
  expect(matrix.modules.length).toBe(matrix.size * matrix.size);
});

test("GET /api/qr rejects an empty data param", async () => {
  const handle = await startServer();
  const res = await fetch(`${handle.url}/api/qr`, { headers: { origin: handle.url } });
  expect(res.status).toBe(400);
});
