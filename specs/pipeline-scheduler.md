# SPEC: pipeline scheduler (DEV-91) — Scheduler phase entry

> Status: **SPEC gate — awaiting architecture approval. Not building yet.**

## Why
Pipelines need triggers (cron / event / manual) plus guardrails, or Vesper is just an on-demand
CLI wrapper. This is the first Scheduler-phase issue and the point where the Foundation
`capabilities` types finally get enforced at run time.

## Reconciliation note (the DEV-91 issue body is pre-pivot)
The current DEV-91 description predates the bring-your-own-CLI pivot. It references
`packages/daemon/`, the `croner` dependency, `vesper ask`, `llm_router` proxying, and
**dollar-based budget caps** (`max_cost_usd_per_run`). Under the locked architecture Vesper shells
out to the user's CLI and **cannot observe token or dollar cost** — the CLI bills the user
directly. So the cost model and several other assumptions must change. The decisions below
reconcile DEV-91 to Foundation; the issue body should be rewritten (show-before-write) once you
approve.

## Architecture decisions needed (the gate)

- **D1 — Budget model.** Vesper has no $ signal from a CLI shell-out. Replace `max_cost_usd_per_run`
  with **`max_runs_per_day`**, **`max_concurrent`**, and optional **`max_duration_ms`** per run.
  No dollar caps in Vesper (the user's CLI subscription is their cost ceiling). *Proposed: yes.*
- **D2 — Cron parsing.** Bun has no built-in cron. Either (a) hand-roll a minimal standard
  5-field cron parser (~80 LOC, zero deps — matches the no-extra-deps rule), or (b) add `croner`
  (needs dependency approval). *Proposed: (a) hand-roll; revisit croner only if DST edge cases bite.*
- **D3 — Location & daemon relationship.** Build the scheduler as a pure, testable
  `packages/vesper-core/src/scheduler/` module (no process management), hosted by the existing
  Foundation `vesper daemon`. Full daemon lifecycle/launchd (DEV-89) stays a separate later issue;
  DEV-91 does **not** require it. *Proposed: scheduler in vesper-core, hosted by `vesper daemon`;
  do NOT block on DEV-89.*
- **D4 — Event bus.** In-process `EventEmitter` (Bun/Node built-in, zero deps). Handlers (cron and
  event) referenced by **allowlisted string IDs**, never `eval`. *Proposed: yes.*
- **D5 — Capability enforcement.** The kickoff defers enforcement to Scheduler. Proposed: before a
  task runs, the scheduler checks the task's declared `Capability` set against an allowlist and
  refuses disallowed capabilities — this is where the Foundation `capabilities` types finally bite.
  *Confirm: full enforcement in DEV-91, or a dedicated sub-issue?*
- **D6 — What gets scheduled.** `packages/pipelines/` is still empty. Proposed: DEV-91 schedules
  **tasks** bound to allowlisted handler IDs; the first real pipeline lands in a later Scheduler
  sub-issue. *Confirm: no sample pipeline in DEV-91.*
- **D7 — Split DEV-91?** It bundles cron + event + manual + persistence + run-caps + backoff +
  dead-letter + capability enforcement + a `vesper schedule` CLI — too big for one cycle (it would
  break the "spec fits one screen" rule). *Proposed: split into sub-issues (you authorize creation,
  per Rule 11): (1) scheduler core (cron+event+manual+persistence), (2) guardrails (run-caps +
  backoff + dead-letter), (3) capability enforcement, (4) `vesper schedule` CLI.*

## Proposed shape (pending the decisions above)
- `packages/vesper-core/src/scheduler/` — `Scheduler` (register/unregister/list/run), a minimal
  cron parser, the event bus, a handler registry (string-ID -> function), run-cap + backoff +
  dead-letter logic. Injectable clock for tests.
- Storage migration `002_scheduler.sql` — `scheduled_tasks` + `failed_tasks` tables (extends the
  Foundation storage module; forward-only).
- `vesper schedule list|show|run|enable|disable` — new CLI command group (registry pattern).
- Wire the scheduler loop into the Foundation `vesper daemon`.

## Out of scope
Distributed scheduling; DAG/task dependencies; calendar-aware scheduling; missed-run catchup;
dashboard UI; full daemon lifecycle + launchd (DEV-89); any provider SDK or $ cost tracking.

## Acceptance (SHALL — finalized after the decisions land)
- GIVEN a cron task WHEN its schedule elapses (injected clock) THEN its handler runs and the run
  is recorded.
- GIVEN an event task subscribed to a topic WHEN that event is emitted THEN its handler runs.
- GIVEN `vesper schedule run <id>` THEN the task runs once on demand.
- GIVEN `max_runs_per_day` exceeded THEN the task is disabled with an audited reason.
- GIVEN a task that fails repeatedly THEN exponential backoff, then dead-letter after N attempts.
- GIVEN a registered task WHEN the host restarts THEN the task is still scheduled (persisted).
- GIVEN a task requesting a disallowed capability THEN it is refused before execution.
- `bun test` >=80% on `scheduler/`; clock injected so no real waiting in the suite.
