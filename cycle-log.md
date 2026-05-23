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
