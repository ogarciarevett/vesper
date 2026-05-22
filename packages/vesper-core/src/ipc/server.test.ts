import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ipcRequest } from "./client.ts";
import { IpcError } from "./errors.ts";
import { startIpcServer } from "./server.ts";
import type { IpcServerHandle } from "./types.ts";

/** Generate a unique socket path under the OS temp directory. */
function tempSocketPath(): string {
  return join(tmpdir(), `vesper-ipc-test-${process.pid}-${Date.now()}.sock`);
}

/** Silently remove a socket file; ignore errors. */
function tryClean(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // File may not exist after a clean stop — ignore.
  }
}

describe("startIpcServer / ipcRequest", () => {
  let server: IpcServerHandle | undefined;
  let socketPath: string;

  beforeEach(() => {
    socketPath = tempSocketPath();
  });

  afterEach(() => {
    server?.stop();
    server = undefined;
    tryClean(socketPath);
  });

  // DEV-105 acceptance criterion 1
  test("ping returns { ok: true, version: '0.1.0' }", async () => {
    server = startIpcServer({ socketPath });
    const response = await ipcRequest(socketPath, "ping");
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.version).toBe("0.1.0");
    }
  });

  // DEV-105 acceptance criterion 2
  test("unknown method returns 501 Not Implemented", async () => {
    server = startIpcServer({ socketPath });
    const response = await ipcRequest(socketPath, "nonExistentMethod");
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe(501);
      expect(response.error.message).toBe("Not Implemented");
      expect(response.error.method).toBe("nonExistentMethod");
    }
  });

  test("custom version is returned in ping response", async () => {
    server = startIpcServer({ socketPath, version: "9.9.9" });
    const response = await ipcRequest(socketPath, "ping");
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.version).toBe("9.9.9");
    }
  });

  test("server handle exposes the resolved socketPath", () => {
    server = startIpcServer({ socketPath });
    expect(server.socketPath).toBe(socketPath);
  });

  test("repeated starts on the same path succeed (stale socket cleanup)", () => {
    const first = startIpcServer({ socketPath });
    first.stop();
    // If stale cleanup does not work this line throws EADDRINUSE.
    server = startIpcServer({ socketPath });
    expect(server.socketPath).toBe(socketPath);
  });

  test("malformed JSON returns 400 Bad Request", async () => {
    server = startIpcServer({ socketPath });

    // Send raw bytes manually so we bypass the JSON helper in ipcRequest.
    const raw = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 5_000);

      Bun.connect<{ buf: string; timer: ReturnType<typeof setTimeout> }>({
        unix: socketPath,
        socket: {
          open(socket) {
            socket.data = { buf: "", timer };
            socket.write("not-valid-json\n");
          },
          data(socket, chunk: Buffer) {
            socket.data.buf += chunk.toString("utf8");
            if (socket.data.buf.includes("\n")) {
              clearTimeout(socket.data.timer);
              resolve(socket.data.buf.slice(0, socket.data.buf.indexOf("\n")));
              socket.end();
            }
          },
          connectError(_socket, error) {
            clearTimeout(timer);
            reject(error);
          },
          close() {},
          error(_socket, error) {
            reject(error);
          },
        },
      }).catch((err: unknown) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    const parsed: unknown = JSON.parse(raw);
    expect(parsed).toMatchObject({ ok: false, error: { code: 400, message: "Bad Request" } });
  });

  test("request with missing method field returns 400 Bad Request", async () => {
    server = startIpcServer({ socketPath });

    const raw = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 5_000);

      Bun.connect<{ buf: string; timer: ReturnType<typeof setTimeout> }>({
        unix: socketPath,
        socket: {
          open(socket) {
            socket.data = { buf: "", timer };
            socket.write('{"notMethod": "ping"}\n');
          },
          data(socket, chunk: Buffer) {
            socket.data.buf += chunk.toString("utf8");
            if (socket.data.buf.includes("\n")) {
              clearTimeout(socket.data.timer);
              resolve(socket.data.buf.slice(0, socket.data.buf.indexOf("\n")));
              socket.end();
            }
          },
          connectError(_socket, error) {
            clearTimeout(timer);
            reject(error);
          },
          close() {},
          error(_socket, error) {
            reject(error);
          },
        },
      }).catch((err: unknown) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    const parsed: unknown = JSON.parse(raw);
    expect(parsed).toMatchObject({ ok: false, error: { code: 400 } });
  });

  test("ipcRequest rejects with IpcError(connection_failed) when server is not running", async () => {
    // Use a path where no server is listening.
    const error = await ipcRequest(tempSocketPath(), "ping").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IpcError);
    expect((error as IpcError).reason).toBe("connection_failed");
  });

  test("server accepts multiple sequential requests on the same connection", async () => {
    server = startIpcServer({ socketPath });

    // Make two independent requests over separate connections (ipcRequest opens a new conn each time).
    const [r1, r2] = await Promise.all([
      ipcRequest(socketPath, "ping"),
      ipcRequest(socketPath, "unknownMethod"),
    ]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(false);
  });

  test("server that sends back non-JSON causes ipcRequest to reject with connection_failed", async () => {
    // Set up a server that echoes garbage instead of JSON.
    const garbagePath = tempSocketPath();
    const garbageListener = Bun.listen<{ buf: string }>({
      unix: garbagePath,
      socket: {
        open(socket) {
          socket.data = { buf: "" };
        },
        data(socket, chunk: Buffer) {
          socket.data.buf += chunk.toString("utf8");
          if (socket.data.buf.includes("\n")) {
            socket.write("not-valid-json\n");
          }
        },
        close() {},
        error() {},
      },
    });

    try {
      const error = await ipcRequest(garbagePath, "ping").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(IpcError);
      expect((error as IpcError).reason).toBe("connection_failed");
    } finally {
      garbageListener.stop(true);
      tryClean(garbagePath);
    }
  });

  test("ipcRequest rejects with IpcError(timeout) when server accepts but never responds", async () => {
    // A server that opens connections but never writes back.
    const silentPath = tempSocketPath();
    const silentListener = Bun.listen<{ buf: string }>({
      unix: silentPath,
      socket: {
        open(socket) {
          socket.data = { buf: "" };
        },
        data(socket, chunk: Buffer) {
          // Intentionally silent — consume data but never respond.
          socket.data.buf += chunk.toString("utf8");
        },
        close() {},
        error() {},
      },
    });

    try {
      const error = await ipcRequest(silentPath, "ping", { timeoutMs: 50 }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(IpcError);
      expect((error as IpcError).reason).toBe("timeout");
    } finally {
      silentListener.stop(true);
      tryClean(silentPath);
    }
  });

  test("server that sends back a non-object JSON value causes ipcRequest to reject with connection_failed", async () => {
    // A server that sends back a JSON array — violates response shape.
    const badPath = tempSocketPath();
    const badListener = Bun.listen<{ buf: string }>({
      unix: badPath,
      socket: {
        open(socket) {
          socket.data = { buf: "" };
        },
        data(socket, chunk: Buffer) {
          socket.data.buf += chunk.toString("utf8");
          if (socket.data.buf.includes("\n")) {
            socket.write("[1,2,3]\n");
          }
        },
        close() {},
        error() {},
      },
    });

    try {
      const error = await ipcRequest(badPath, "ping").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(IpcError);
      expect((error as IpcError).reason).toBe("connection_failed");
    } finally {
      badListener.stop(true);
      tryClean(badPath);
    }
  });
});
