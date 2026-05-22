/** A parsed IPC request received from a client. */
export interface IpcRequest {
  /** The method name identifying the operation. */
  readonly method: string;
}

/** A successful response. */
export interface IpcOkResponse {
  readonly ok: true;
  readonly version: string;
}

/** An error detail block carried in error responses. */
export interface IpcErrorDetail {
  /** HTTP-style error code (400 = bad request, 501 = not implemented). */
  readonly code: number;
  readonly message: string;
  /** Present in 501 responses — echoes back the requested method. */
  readonly method?: string;
  /** Present in 400 responses — human-readable parse/validation detail. */
  readonly detail?: string;
}

/** An error response. */
export interface IpcErrorResponse {
  readonly ok: false;
  readonly error: IpcErrorDetail;
}

/** Every response from the IPC server is one of these. */
export type IpcResponse = IpcOkResponse | IpcErrorResponse;

/** Handle returned by {@link startIpcServer}. */
export interface IpcServerHandle {
  /** Absolute path of the bound socket file. */
  readonly socketPath: string;
  /** Stop the server and unlink the socket file. */
  stop(): void;
}

/** Options for {@link startIpcServer}. */
export interface IpcServerOptions {
  /**
   * Path of the Unix socket file to bind.
   * Defaults to `~/.vesper/run/vesper.sock`.
   */
  readonly socketPath?: string;
  /**
   * Version string returned in ping responses.
   * Defaults to the package version.
   */
  readonly version?: string;
}
