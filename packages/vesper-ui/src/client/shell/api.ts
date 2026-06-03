/// <reference lib="dom" />
import type { ApiClient } from "./section.ts";

/** Error carrying the server's status + parsed `{ error }` message, when present. */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<T> {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["content-type"] = "application/json";
  }
  const res = await fetch(path, init);
  const text = await res.text();
  const parsed: unknown = text.length > 0 ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg =
      parsed !== null && typeof parsed === "object" && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : `request failed (${res.status})`;
    throw new ApiError(res.status, msg);
  }
  return parsed as T;
}

/** The shared section API client — thin fetch wrapper over the local daemon. */
export function createApiClient(): ApiClient {
  return {
    getJson: (path) => request("GET", path),
    postJson: (path, body, headers) => request("POST", path, body, headers),
    putJson: (path, body, headers) => request("PUT", path, body, headers),
  };
}
