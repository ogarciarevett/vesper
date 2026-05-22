export type { IpcRequestOptions } from "./client.ts";
export { ipcRequest } from "./client.ts";
export type { IpcErrorReason } from "./errors.ts";
export { IpcError } from "./errors.ts";
export { startIpcServer } from "./server.ts";
export type {
  IpcErrorDetail,
  IpcErrorResponse,
  IpcOkResponse,
  IpcRequest,
  IpcResponse,
  IpcServerHandle,
  IpcServerOptions,
} from "./types.ts";
