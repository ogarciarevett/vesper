# OpenSpec: IPC Unix-Socket Server Stub (DEV-105)

## Why

Vesper's operator surfaces (`vesper status`, `vesper daemon`, future pipeline controls) need a
stable, local inter-process communication channel. A Unix-domain socket is the natural choice for
a local-first desktop runtime: no port allocation, no firewall exposure, low latency.

Foundation requires only a minimal stub: the server MUST respond to `ping` and return 501 for
every other method. Real methods (pipeline lifecycle, budget queries, audit log) land in
Scheduler (DEV-91) and later phases.

## What Changes

A new module `packages/vesper-core/src/ipc/` is added. No existing files are modified.

### Files created

| File | Purpose |
|---|---|
| `packages/vesper-core/src/ipc/errors.ts` | `IpcError` extending `VesperError`; typed reasons |
| `packages/vesper-core/src/ipc/types.ts` | Protocol types: request, response, server handle |
| `packages/vesper-core/src/ipc/server.ts` | `startIpcServer` — Bun unix-socket server |
| `packages/vesper-core/src/ipc/client.ts` | `ipcRequest` — single-shot client helper |
| `packages/vesper-core/src/ipc/index.ts` | Public barrel re-export |
| `packages/vesper-core/src/ipc/server.test.ts` | `bun:test` acceptance tests (DEV-105 criteria) |

## Protocol

### Transport

- Unix-domain stream socket at `~/.vesper/run/vesper.sock` (default).
- The `startIpcServer` function accepts an explicit `socketPath` override (used by tests and by
  `vesper daemon`).

### Message framing

Newline-delimited JSON (NDJSON). Each message is a single line terminated by `\n`. The server
reads lines, parses each as JSON, and responds with a single JSON line followed by `\n`.

### Request shape

```json
{ "method": "<string>", ...optionalFields }
```

- `method` (required): identifies the operation.
- Additional fields are ignored by the stub.

### Response shapes

**Ping success:**
```json
{ "ok": true, "version": "0.1.0" }
```

**Not implemented (any method other than `ping`):**
```json
{ "ok": false, "error": { "code": 501, "message": "Not Implemented", "method": "<method>" } }
```

**Parse error (malformed JSON or missing `method`):**
```json
{ "ok": false, "error": { "code": 400, "message": "Bad Request", "detail": "<description>" } }
```

## Impact

- `vesper daemon` command (vesper-cli) starts the server via `startIpcServer`.
- `vesper status` command uses `ipcRequest` to health-check the running daemon.
- Future Scheduler methods extend the server without changing the wire format.

## Design Decisions

1. **Bun native sockets (`Bun.listen` / `Bun.connect`)** — no `node:net` required; the Bun
   socket API is synchronous/callback-based on the server side and Promise-based on the client
   side, which fits this use case without adding dependencies.

2. **Stale socket cleanup** — on `startIpcServer`, any existing socket file at `socketPath` is
   unlinked before binding. On `stop()`, the socket file is unlinked after closing the listener.
   This ensures repeated starts work correctly even if the previous process crashed.

3. **`version` default from `package.json`** — `import pkg from "../../package.json"` with
   `resolveJsonModule: true`. If the import is unavailable, falls back to the literal `"0.1.0"`.

4. **No `any`** — all JSON parsing uses `unknown` with explicit narrowing helpers.

5. **Per-connection buffer** — each accepted socket accumulates bytes in a string buffer until a
   `\n` is found; only then is the line parsed and a response sent. This handles fragmented TCP
   writes correctly.

6. **Client helper timeout** — `ipcRequest` sets a 5 second connection timeout; if the server
   does not respond within that window the promise rejects with an `IpcError("timeout")`.

## Acceptance Criteria (GIVEN/WHEN/THEN)

GIVEN the IPC server is started with a temp socket path  
WHEN a client sends `{ "method": "ping" }\n`  
THEN the response is `{ "ok": true, "version": "0.1.0" }` (parsed JSON)

GIVEN the IPC server is started  
WHEN a client sends `{ "method": "unknownMethod" }\n`  
THEN the response is `{ "ok": false, "error": { "code": 501, "message": "Not Implemented", "method": "unknownMethod" } }`

GIVEN the IPC server is started  
WHEN a client sends malformed JSON `not-json\n`  
THEN the response is `{ "ok": false, "error": { "code": 400, "message": "Bad Request", ... } }`

GIVEN the IPC server has been started once and then stopped  
WHEN `startIpcServer` is called again with the same socket path  
THEN the server starts successfully (stale socket cleaned up)

## Out of Scope

- Full daemon lifecycle management (Scheduler/DEV-91)
- Healthcheck endpoint beyond `ping`
- Audit log
- Real method implementations
- Authentication / authorization
- TLS on the Unix socket
