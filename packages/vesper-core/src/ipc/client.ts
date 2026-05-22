import type { Socket } from "bun";
import { IpcError } from "./errors.ts";
import type { IpcResponse } from "./types.ts";

/** Default request timeout in milliseconds. Overridable via {@link ipcRequest} options for tests. */
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

/** Narrow an unknown value to an {@link IpcResponse}. */
function toIpcResponse(value: unknown): IpcResponse {
  if (typeof value === "object" && value !== null && !Array.isArray(value) && "ok" in value) {
    return value as IpcResponse;
  }
  throw new IpcError("connection_failed", "server returned an unexpected response shape");
}

/** Options for {@link ipcRequest}. */
export interface IpcRequestOptions {
  /**
   * Timeout in milliseconds before rejecting with `IpcError("timeout")`.
   * Defaults to 5000 ms.
   *
   * @internal Exposed for tests; prefer the default in production code.
   */
  readonly timeoutMs?: number;
}

/**
 * Send a single request to the Vesper IPC server and return its parsed response.
 *
 * Opens a new Unix-socket connection, writes `{ "method": method }\n`, waits for a
 * single response line, then closes the connection.
 *
 * @param socketPath - Absolute path to the Unix socket file.
 * @param method - IPC method name (e.g. `"ping"`).
 * @param options - Optional request options.
 * @returns The parsed {@link IpcResponse} object.
 * @throws {IpcError} with reason `"timeout"` if no response arrives within the timeout.
 * @throws {IpcError} with reason `"connection_failed"` on network or parse error.
 */
export async function ipcRequest(
  socketPath: string,
  method: string,
  options: IpcRequestOptions = {},
): Promise<IpcResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  return new Promise<IpcResponse>((resolve, reject) => {
    // settled guards against double-resolution (e.g. error fires after close).
    let settled = false;
    let lineBuffer = "";

    function settle(fn: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    }

    const timer = setTimeout(() => {
      settle(() => reject(new IpcError("timeout", `IPC request timed out after ${timeoutMs} ms`)));
    }, timeoutMs);

    const socketHandler: Parameters<typeof Bun.connect>[0]["socket"] = {
      open(socket: Socket) {
        socket.write(`${JSON.stringify({ method })}\n`);
      },

      data(_socket: Socket, chunk: Buffer) {
        lineBuffer += chunk.toString("utf8");

        const newlineIndex = lineBuffer.indexOf("\n");
        if (newlineIndex === -1) return;

        const line = lineBuffer.slice(0, newlineIndex).trim();

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (cause) {
          settle(() =>
            reject(
              new IpcError("connection_failed", "could not parse server response as JSON", {
                cause,
              }),
            ),
          );
          _socket.end();
          return;
        }

        try {
          const response = toIpcResponse(parsed);
          settle(() => resolve(response));
        } catch (err) {
          settle(() => reject(err));
        }
        _socket.end();
      },

      close(_socket: Socket) {
        // Nothing; promise was already settled or the timeout will fire.
      },

      connectError(_socket: Socket, error: Error) {
        settle(() =>
          reject(
            new IpcError("connection_failed", `could not connect to IPC socket: ${error.message}`, {
              cause: error,
            }),
          ),
        );
      },

      error(_socket: Socket, error: Error) {
        settle(() =>
          reject(
            new IpcError("connection_failed", `IPC socket error: ${error.message}`, {
              cause: error,
            }),
          ),
        );
      },
    };

    Bun.connect({
      unix: socketPath,
      socket: socketHandler,
    }).catch((err: unknown) => {
      settle(() =>
        reject(
          new IpcError(
            "connection_failed",
            err instanceof Error ? err.message : "unknown connection error",
            { cause: err },
          ),
        ),
      );
    });
  });
}
