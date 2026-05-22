import { unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Socket } from "bun";
// Import package version — resolveJsonModule is enabled in tsconfig.base.json.
import pkg from "../../package.json";
import type {
  IpcErrorResponse,
  IpcOkResponse,
  IpcRequest,
  IpcServerHandle,
  IpcServerOptions,
} from "./types.ts";

const FALLBACK_VERSION = "0.1.0";
const DEFAULT_SOCKET_PATH = join(homedir(), ".vesper", "run", "vesper.sock");

/** Per-connection mutable state stored in `socket.data`. */
interface ConnectionData {
  /** Partial line buffer awaiting a newline. */
  buffer: string;
}

/** Narrow an unknown value to a plain object (not array, not null). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse a raw line into an IpcRequest, or return a description of why it failed. */
function parseLine(
  line: string,
): { ok: true; request: IpcRequest } | { ok: false; detail: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, detail: "JSON parse error" };
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, detail: "request must be a JSON object" };
  }

  const method = parsed.method;
  if (typeof method !== "string" || method.length === 0) {
    return { ok: false, detail: 'field "method" must be a non-empty string' };
  }

  return { ok: true, request: { method } };
}

/** Build the newline-terminated JSON line to write back to the socket. */
function buildResponse(version: string, request: IpcRequest): string {
  if (request.method === "ping") {
    const response: IpcOkResponse = { ok: true, version };
    return `${JSON.stringify(response)}\n`;
  }

  const response: IpcErrorResponse = {
    ok: false,
    error: { code: 501, message: "Not Implemented", method: request.method },
  };
  return `${JSON.stringify(response)}\n`;
}

/** Build a 400 Bad Request response line. */
function buildBadRequestResponse(detail: string): string {
  const response: IpcErrorResponse = {
    ok: false,
    error: { code: 400, message: "Bad Request", detail },
  };
  return `${JSON.stringify(response)}\n`;
}

/** Silently attempt to unlink a socket file; ignore errors (e.g. file not found). */
function tryUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Intentional: stale socket may not exist — that is fine.
  }
}

/**
 * Start the Vesper IPC Unix-socket server.
 *
 * The server binds to `socketPath` (creating or replacing any existing socket
 * file). It speaks newline-delimited JSON: each request line is parsed, dispatched,
 * and answered with a single JSON response line.
 *
 * @param options - Server configuration; all fields are optional.
 * @returns A handle with `socketPath` and `stop()`.
 */
export function startIpcServer(options: IpcServerOptions = {}): IpcServerHandle {
  const socketPath = options.socketPath ?? DEFAULT_SOCKET_PATH;
  const version =
    options.version ??
    (typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : FALLBACK_VERSION);

  // Remove any stale socket file before binding so repeated starts succeed.
  tryUnlink(socketPath);

  const listener = Bun.listen<ConnectionData>({
    unix: socketPath,
    socket: {
      open(socket: Socket<ConnectionData>) {
        socket.data = { buffer: "" };
      },

      data(socket: Socket<ConnectionData>, chunk: Buffer) {
        // Accumulate data; process complete lines (terminated by \n).
        socket.data.buffer += chunk.toString("utf8");

        for (;;) {
          const newlineIndex = socket.data.buffer.indexOf("\n");
          if (newlineIndex === -1) break;

          const line = socket.data.buffer.slice(0, newlineIndex).trim();
          socket.data.buffer = socket.data.buffer.slice(newlineIndex + 1);

          if (line.length === 0) continue;

          const parsed = parseLine(line);
          if (parsed.ok) {
            socket.write(buildResponse(version, parsed.request));
          } else {
            socket.write(buildBadRequestResponse(parsed.detail));
          }
        }
      },

      close(_socket: Socket<ConnectionData>) {
        // Connection closed by the peer — nothing to do.
      },

      error(_socket: Socket<ConnectionData>, _error: Error) {
        // Per-connection errors are silently absorbed; the server keeps running.
      },
    },
  });

  return {
    socketPath,
    stop(): void {
      listener.stop(true);
      tryUnlink(socketPath);
    },
  };
}
