# SPEC: UI/UX pipeline (#2) — `ui.react-page`, then `open-design`

> Status: **DEFERRED — pipeline #2 (a React-PAGE-generating pipeline).** NOTE (2026-05-28): this is
> NOT the elder-first consumer UI shell. That Desktop direction (Hard rule 14 — Bun/TS/web stack,
> usable by a non-technical 70-year-old) is a separate, not-yet-written `specs/elder-first-ui.md`,
> blocked on Omar's product decisions. Also STALE here: the "FULL runtime contract" below (persisted
> task `cli`/`params`, migration 005, `ctx.writeFile`/`FS_WRITE`) describes a contract the shipped
> first-pipeline runtime did NOT build — the shipped `PipelineContext` is minimal (`complete` +
> `recordRun`) and migrations stop at `004_capabilities`. Treat the runtime sections below as a
> proposal to reconcile, not as built fact. Build only after the elder-first decision lands.
> Linear: no active issue (DEV-95/96/97 specializations + DEV-19 webpage-generator are Canceled);
> workspace is issue-cap'd. Reconcile to a DEV issue when the cap lifts.

## Why

Vesper has a fully-built scheduler (cron/event/manual, guardrails, capability enforcement) but
**zero pipelines** — `daemon.ts` registers an empty `HandlerRegistry`, so `vesper schedule list` is
empty and nothing can run. The host is plumbing with nothing plugged in. The first pipeline turns
"plumbing works" into "Vesper does something," and — more importantly — establishes the **pipeline
runtime contract** every future pipeline (open-design, hermes, etc.) inherits.

The chosen first pipeline is the minimal end-to-end slice: generate a React page locally via the
user's CLI. It is 100% Vesper-native (no external orchestrator, no new runtime deps) and exercises
exactly the path we must validate: trigger -> capability-gated handler -> CLI adapter -> FS + runs.

## Core requirement (Omar): trigger via any CLI, decide the LLM from the request

A task is NOT bound to one CLI. The LLM/CLI is selected **per request**, resolution order:

1. per-run override: `vesper schedule run <id> --cli <claude|opencode|codex|gemini>`
2. the task's stored `cli` field
3. the configured default (`cli.default` in `~/.vesper/config.json`)

The handler is **CLI-agnostic** — it asks the runtime to `complete(prompt)` and the runtime invokes
whichever adapter the request resolved to. This is the same shell-out proven by `vesper hello`.

## What Changes

1. **Scheduler task model** (extend; migration `005`): add optional `cli` (adapter name) and
   `params_json` (small JSON: the brief/prompt, output dir) to `ScheduledTask` / `RegisterTaskInput`.
2. **Pipeline runtime context** — replace the bare `TaskContext` with a capability-gated handle the
   handler receives:
   - `ctx.complete(prompt, { cli? })` -> resolves the adapter (per resolution order) and shells out.
     Requires `CLI_INVOKE`.
   - `ctx.writeFile(relPath, contents)` under the task's output dir. Requires `FS_WRITE`.
   - `ctx.recordRun({ status, summary })` -> writes a `runs` row. Requires `WRITE_STORAGE`.
   - `ctx.params`, `ctx.task`, `ctx.now`. Every gated method checks the task's
     `required_capabilities` first (reuses the DEV-109 enforcement) and throws `CapabilityError` if
     not granted.
3. **`packages/pipelines/ui-react-page/`** — handler id `ui.react-page`, caps
   `[CLI_INVOKE, FS_WRITE, WRITE_STORAGE]`. Single-agent: one `ctx.complete()` with a prompt built
   from `params.brief` -> parse fenced files from the response -> `ctx.writeFile` each into
   `params.outDir` (default `./out/ui-react-page/`) -> `ctx.recordRun`.
4. **CLI surface:** `vesper schedule add <id> --handler ui.react-page --kind manual --cli <name>
   --param brief="..." --param outDir=...` (create a manual task), and `--cli` override on
   `vesper schedule run`. Wire the pipeline + its registration into the daemon `HandlerRegistry`.

## Design Decisions

- **Per-request CLI selection is first-class** (the resolution order above) — handlers never hardcode
  a CLI. [Omar requirement.]
- **Capability-gated context:** the handler can only invoke a CLI / write files / write storage if
  the task declares the matching capability; enforced by the existing capability layer. This is
  where Foundation's capability types finally gate real side effects.
- **Vesper stays dependency-clean:** the pipeline *generates* a React project into an output dir; it
  does NOT add React/Next as a Vesper dependency. Output is plain files written via `Bun.write`.
- **Start single-agent.** Multi-agent (fan out to N adapters for disjoint files — component / styles
  / test — then the lead assembles) is the showcase extension, deferred to keep the first slice a
  clean proof.

## Out of Scope (deferred / flagged)

- **open-design integration** (https://github.com/nexu-io/open-design) — the flagship UI pipeline
  #2 once this contract is proven; too heavyweight (it is itself a CLI orchestrator) for the first
  slice.
- **Multi-agent fan-out** — extension after the single-agent path is green.
- **Agent-SDK / orchestrator backends (Mastra et al.)** — CONFLICTS with Hard Rule 12 (no provider
  SDKs) and the bring-your-own-CLI model (Mastra needs provider keys/SDKs). Permissible only as a
  separate sandboxed comparison spike to evaluate the tradeoff; making it a core pipeline backend
  requires a deliberate architecture revision (Omar's explicit decision). NOT built here.
- **cron/event triggers** for this pipeline — manual run first; scheduling is already proven.

## Acceptance (SHALL)

- GIVEN `vesper schedule run ui.react-page --cli codex` WHEN it runs THEN it invokes the **codex**
  adapter (not the default), writes the generated React files under the output dir, and records a
  `runs` row with `status` + `summary`.
- GIVEN no `--cli` override THEN the run uses the task's `cli`, else the configured default — proving
  the LLM is decided from the request.
- GIVEN the same task run with `--cli claude` vs `--cli opencode` THEN both succeed via their
  respective adapters (CLI-agnostic handler).
- GIVEN a task whose `required_capabilities` omit `CLI_INVOKE` THEN the run is refused with
  `CapabilityError` before any CLI is invoked.
- GIVEN a completed run THEN `vesper schedule list` shows `last_run_at` set and storage has the run.
- `bun test` >=80% on the new pipeline + runtime-context code; `biome ci` clean.
