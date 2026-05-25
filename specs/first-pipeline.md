# SPEC: first pipeline — runtime contract + `echo` validator

> Status: **SPEC gate — awaiting Omar's acknowledgment. Not building yet.**
> Linear: no active issue (pipeline specializations Canceled); workspace issue-cap'd. This file is
> the SPEC artifact under the contract's Linear-unavailable fallback; reconcile to a DEV issue when
> the cap lifts.

## Why

Vesper's scheduler is fully built but runs nothing — `daemon.ts` registers an empty
`HandlerRegistry`, so `vesper schedule list` is empty. Before building anything UI-shaped, validate
the **pipeline runtime path** end-to-end with the smallest possible non-UI pipeline: a manual task
that shells out to the user's chosen CLI and records the run. This confirms the bring-your-own-CLI
direction is right and establishes the runtime contract the UI/UX pipeline (and all others) inherit.
Deliberately not a UI generator — isolate "does the runtime work" from "can it build a UI".

## Core requirement (Omar): decide the LLM from the request

The CLI/LLM is chosen **per request**, not bound to the task. Resolution order for this slice:

1. per-run override: `vesper schedule run echo --cli <claude|opencode|codex|gemini>`
2. the configured default (`cli.default` in `~/.vesper/config.json`)

(Persisting a `cli` on the task itself is deferred to the UI pipeline — see Out of Scope.) The
handler is CLI-agnostic: it calls `ctx.complete(prompt)` and the runtime invokes whichever adapter
the request resolved to — the same shell-out proven by `vesper hello`.

## What Changes

1. **Pipeline runtime context** — handlers receive a capability-gated context (not today's bare
   `{ task, now }`):
   - `ctx.complete(prompt, { cli? })` -> resolve adapter (run-override -> default) -> shell out.
     Requires `CLI_INVOKE`.
   - `ctx.recordRun({ status, summary })` -> write a `runs` row. Requires `WRITE_STORAGE`.
   - `ctx.params` (transient, from the run), `ctx.task`, `ctx.now`.
   - Every gated method calls the existing DEV-109 capability check first; throws `CapabilityError`
     if the task's `required_capabilities` omit it. (No `FS_WRITE` in this slice.)
2. **`packages/pipelines/echo/`** — handler id `echo`, caps `[CLI_INVOKE, WRITE_STORAGE]`. Sends a
   prompt (from `--param prompt="..."`, else a fixed self-test prompt) through the resolved CLI via
   `ctx.complete`, then `ctx.recordRun({ status, summary: <trimmed response> })`.
3. **CLI + wiring:** `vesper schedule run echo --cli <name> [--param prompt="..."]` (run-override
   CLI selection; param is transient — no persistence). Register the `echo` handler + a manual
   `echo` task into the daemon `HandlerRegistry`.

## Design Decisions

- **Per-request CLI selection via run-override** is the minimal form of "decide the LLM from the
  request" and is enough to validate direction. Persisting `cli`/`params` on tasks (migration) is
  deferred to the UI pipeline.
- **No scheduler migration in this slice** — params are passed transiently to the run, not stored.
- **Reuse DEV-109 capability enforcement** at the handler-context boundary — this is where the
  Foundation capability types finally gate a real side effect (CLI invocation + storage write).
- **`runs` table already exists** (Foundation storage: `runs(id, ts, pipeline, status, summary)`) —
  the validator writes there; no schema change.

## Out of Scope (deferred / flagged)

- **UI/UX pipeline** (`ui.react-page` -> later `open-design`) — pipeline #2; builds on this runtime.
  See `specs/ui-react-page-pipeline.md`.
- **Persisted task `cli` + `params` (migration 005), `vesper schedule add`** — land with the UI
  pipeline when scheduled (non-manual) runs need them.
- **Agent-SDK / orchestrator backends (Mastra et al.)** — conflicts with Hard Rule 12 (no provider
  SDKs) + bring-your-own-CLI. Permissible only as a separate sandboxed comparison spike; a core
  backend needs a deliberate architecture revision (Omar's explicit call). Not built here.
- `FS_WRITE`, multi-agent fan-out, cron/event triggers for this pipeline.

## Acceptance (SHALL)

- GIVEN `vesper schedule run echo --cli codex` WHEN it runs THEN it invokes the **codex** adapter
  (not the default) and writes a `runs` row with `status` + `summary`.
- GIVEN `vesper schedule run echo --cli claude` THEN it invokes **claude** — same handler, LLM
  decided from the request (CLI-agnostic).
- GIVEN no `--cli` override THEN it uses the configured default.
- GIVEN the `echo` task's `required_capabilities` omit `CLI_INVOKE` THEN the run is refused with
  `CapabilityError` before any CLI is invoked.
- GIVEN a completed run THEN storage has the `runs` row and `vesper schedule list` shows
  `last_run_at` set.
- `bun test` >=80% on the runtime context + `echo` handler; `biome ci` clean.
