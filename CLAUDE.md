# CLAUDE.md — Vesper

This file is the durable contract for Claude Code sessions in this repo. Read it fully before
acting. It supersedes assumptions from training; when in doubt, follow this file.

---

## Mission

Vesper is a **Personal Agent OS** — a local-first desktop runtime that hosts independent agent
**pipelines** (career-growth, social-autopilot, trading, hermes) under a single
capability-sandboxed host. The user pays once for their CLI subscription and Vesper composes
on top of it; nothing leaves the machine except calls the user's own CLI tool makes.

## Positioning rule (IMPORTANT)

"Personal Agent OS" is the **internal** framing (this file may use it). Until the **Desktop**
phase ships a demoable UI, **all public surfaces** — README, repo description, any issue/PR
copy, commit messages — describe Vesper in mechanics-first language:

> "A local-first runtime for personal automation agents."

No "Agent OS" marketing copy in the repo or commits yet. The **Launch** phase headline can land
that framing; until then, the work speaks first.

## Terminology note

**`pipeline`** is the only canonical Vesper concept (confirmed in Linear DEV-91, the Scheduler
pipeline-scheduler issue). Do **not** use "specialization", "agent", "module", or "plugin" as
synonyms. A pipeline is the unit of personal automation; the host runs pipelines.

---

## Phases (canonical names — use these everywhere)

Use the phase **names** in code, commits, comments, docs, Linear updates, and conversation.
Linear issues carry an `m{n}-` / `[Mn]` slug prefix only because the slug is part of the URL —
that is an external identifier, never a human-readable phase name. Say "Foundation", not "M1";
"deferred to Scheduler", not "deferred to M2".

| Phase | Linear slug prefix | Scope (short) |
|---|---|---|
| **Foundation** | `m1-` | Host runtime — vault, storage, CLI orchestration, IPC. |
| **Scheduler** | `m2-` | Pipeline runtime — cron, event triggers, manual run, budget caps (DEV-91 seed). |
| **Desktop** | `m3-` | Tauri UI shell, system tray, in-app pipeline controls. |
| **Voice** | `m4-` | ElevenLabs voice integration. |
| **Launch** | `m5-` | CI, packaging, distribution, public announcement. |
| (later) | `m6-` / `m7-` | See Linear DEV-86..100 for the full spine. |

Note: Linear's surviving spine tags some later issues differently than these names (e.g. Voice
work currently sits under an `[M3]`-tagged issue). The **phase names above are authoritative**;
the `[Mn]` tags are URL identifiers being reconciled, not the source of phase scope.

---

## Linear (the control center)

- Workspace: `claw-village` (legacy slug, kept for URL stability).
- Project: **Vesper** — https://linear.app/claw-village/project/vesper
- Project ID: `db42c673-b545-43c1-91e5-fba4510fcc31`
- Team: `development` (key `DEV`).
- Spine: **DEV-86..100** cover the architectural spine across all phases. Read them at session
  start to cross-check scope; **if Linear and this file disagree, surface the delta to Omar —
  do not improvise.**

### No work without a Linear issue (hard rule)

If no Linear issue in the Vesper project matches the work you are about to do: **halt loudly**,
report what work you believed was next + the search you ran + what you found, and **wait for
Omar**. Do **not** create issues yourself, do not pick "close enough", do not improvise scope.
Before halting, search the project for keyword matches, Backlog/Todo candidates, and recently
Canceled issues (so you don't redo dropped work). The only standing exception is the **very
first** session bootstrap (writing this file, scaffolding the Bun workspace, the initial
`chore:` commits) — that runs against Omar's kickoff authorization. From the first feature
`/spec` onward, this rule is absolute.

### Linear status protocol (every cycle step transitions the issue)

Omar reads Linear to know where work is. Silent progress is invisible progress. Move status and
post a comment at every step. Map to the closest available workflow state.

| Cycle step | Linear status | Required comment |
|---|---|---|
| Pre-start | Todo / Backlog | (initial) |
| SPEC | In Progress | `SPEC started — proposal at specs/<feature>.md` |
| PLAN | In Progress | `PLAN ready — N tasks` |
| BUILD | In Progress | `BUILD started` + per-task `task N/M complete` |
| TEST | In Review | `TEST passed — coverage X%` OR `TEST failed — returning to BUILD` |
| REVIEW | In Review | `REVIEW complete — no deviations` OR `REVIEW found deltas — see comment` |
| SIMPLIFY | In Review | `SIMPLIFY complete — N lines removed, tests still green` |
| IMPROVE | In Review | `IMPROVE captured — see deltas` OR `IMPROVE — no deltas, pattern held` |
| SHIP/DELEGATE | Done (ship) / Done + new issue (delegate) | `SHIPPED — commit <sha>` OR `DELEGATED → DEV-NNN` |
| REPEAT | (next issue Todo→In Progress) | (begins next issue's SPEC) |

Rules: if returning to a prior step (TEST fails → BUILD), post `REVERTED to BUILD — <reason>`.
Forking into multiple issues requires Omar's authorization first. On SHIP, move to Done only
after the commit lands. Don't delegate into the void — the downstream issue must already exist.
If Linear MCP is unavailable, write transitions to `cycle-log.md` as a fallback for manual
reconciliation.

---

## Architecture (locked for Foundation)

### Stack
- Runtime: **Bun** (≥1.1; dev on 1.3.10). Language: **TypeScript**, strict, **ESM-only**.
- Tests: **`bun:test`**. Lint/format: **Biome** (single tool).
- Storage: **`bun:sqlite`**. Embedding index (sqlite-vec) deferred to Scheduler.
- Secrets vault: **macOS Keychain via `security` CLI** for Foundation, behind a `Vault`
  interface so Linux/Windows backends drop in later. Vault stores **pipeline-side** secrets
  (GitHub tokens, Discord webhooks). It never stores LLM auth — that is the CLI's concern.
- IPC: Unix socket at `~/.vesper/run/vesper.sock` (interface defined in Foundation; server can
  be a stub returning 501 for non-`ping` methods).
- **Only dependency is `@biomejs/biome` (devDep)** (+ `@types/bun` for Bun TS types). No
  `commander`/`zod`/`keytar` — hand-roll the small CLI arg parser. Bun-only: `bun install`,
  `bun run`, `bun test`, `bun x`. No npm/yarn.

### Bring-your-own-CLI commitment (the distribution model, not a preference)
Vesper does **LLM orchestration via CLI adapters, never provider SDKs.** It shells out to the
user's already-authenticated CLI: `claude` (Claude Code), `opencode`, `codex`, or `gemini`. An
adapter wraps each via `Bun.spawn` with stdin/stdout streaming; adapters handle prompt/response
framing only and **never touch tokens, keys, or auth**.

**Hard rule — no LLM provider SDKs, ever:** no `@anthropic-ai/sdk`, `openai`,
`@google/generative-ai`, `cohere-ai`, `@mistralai/mistralai`, `together-ai`, or any other LLM
provider SDK. If a pipeline appears to need direct API access, the pipeline is wrong — rewrite
it onto the CLI adapter layer. The only network calls Vesper makes are to first-party services
pipelines explicitly opt into (GitHub, Discord, Notion) — never to LLM providers.

### Workspace layout (Bun monorepo)
```
vesper/
├── packages/
│   ├── vesper-core/   # host runtime: vault, storage, cli adapters, capabilities, ipc
│   ├── vesper-cli/    # `vesper` command — operator surface for Foundation
│   └── pipelines/     # pipelines land here from Scheduler onward (DEV-91); .gitkeep for now
├── package.json       # workspaces: ["packages/*"]
├── biome.json
├── tsconfig.base.json
├── CLAUDE.md          # this file
├── cycle-log.md       # IMPROVE-step persistence (one entry per feature cycle)
└── README.md          # mechanics-first
```

### Core modules (`packages/vesper-core/src/`)
- **`vault/`** — Keychain-backed secrets (pipeline-side auth). `get/set/delete/list`. Throws
  `VaultError` with typed reasons (`not_found`, `permission_denied`, `keychain_unavailable`).
- **`storage/`** — `bun:sqlite` wrapper + migration runner. Foundation schema: `events`
  (id, ts, source, kind, payload_json) and `runs` (id, ts, pipeline, status, summary).
- **`cli/`** — CLI orchestration. `CLIAdapter` interface: `complete(prompt, opts)` →
  `{ text, exit_code, raw_stdout, raw_stderr, duration_ms }`. Implementations:
  `ClaudeCodeAdapter`, `OpenCodeAdapter`, `CodexAdapter`, `GeminiCLIAdapter`.
  `detectAvailableCLIs()` (which on each binary), `selectDefault(installed)` (configured default
  or priority `claude > opencode > codex > gemini`). Each adapter has `probe()` (no-op prompt to
  verify authenticated + responding). Probe failures throw `CLIError` with typed reasons
  (`not_installed`, `not_authenticated`, `timeout`, `nonzero_exit`). Config in
  `~/.vesper/config.json` under `cli.default` and `cli.adapters.<name>.{command, args}`.
- **`capabilities/`** — type-only for Foundation. `Capability` enum: `READ_VAULT`, `WRITE_VAULT`,
  `READ_STORAGE`, `WRITE_STORAGE`, `CLI_INVOKE` (replaces LLM_CALL — pipelines request the right
  to invoke a CLI, not to call a model), `NETWORK_FETCH`, `FS_READ`, `FS_WRITE`. Enforcement
  lands in Scheduler.
- **`ipc/`** — Unix-socket server stub at `~/.vesper/run/vesper.sock`. `ping` → `{ ok: true,
  version }`. All other methods → 501 Not Implemented.

### CLI surface (`packages/vesper-cli/src/`) — Foundation commands
- `vesper init` — create `~/.vesper/` tree, init sqlite DB + migrations, detect installed CLIs,
  write starter `config.json` with auto-selected default.
- `vesper vault set|get|list <key>` — Keychain via core vault (pipeline secrets only). `list`
  never prints values.
- `vesper cli list` — installed CLIs with probe status (OK / not-authenticated / not-installed).
- `vesper cli select <name>` — set default CLI in config (validate against detected list).
- `vesper hello` — invoke configured default CLI with a fixed prompt, capture stdout, print it.
  Foundation acceptance demo: proves orchestration without Vesper touching any provider API/auth.
- `vesper status` — versions, vault, storage, IPC socket, configured CLI + probe result.
- `vesper daemon` — start the IPC socket server.

---

## The canonical Vesper cycle (mandatory for every unit of work)

`SPEC → PLAN → BUILD → TEST → REVIEW → SIMPLIFY → IMPROVE → SHIP/DELEGATE → REPEAT`

1. **SPEC** — declare the unit of work as an OpenSpec proposal at `specs/<feature>.md`.
2. **PLAN** — break the spec into ordered, individually-completable tasks.
3. **BUILD** — produce the artifact, task by task (TDD for vault/storage/cli).
4. **TEST** — verify against acceptance criteria. Fail → back to BUILD (post REVERTED comment).
5. **REVIEW** — self-review the diff against spec. Flag deviations.
6. **SIMPLIFY** — reduce. Delete dead branches, collapse needless abstraction, inline single-use
   helpers. Re-run TEST. Always reduce.
7. **IMPROVE** — write a reflection to `cycle-log.md` + Linear (deltas, lessons, reusable
   patterns). If none: "no deltas — pattern held". Non-skippable.
8. **SHIP/DELEGATE** — single Conventional Commit (+ PR/release), or hand off to a downstream
   issue that already exists in Linear.
9. **REPEAT** — pick the next-highest-priority backlog issue, re-enter at SPEC. Empty backlog =
   halt and report.

This is the same cycle Vesper pipelines run autonomously from Scheduler onward. Building
Foundation by hand is the dogfood pass — every shortcut here is inherited by the pipelines.
A feature is **not done** until SHIP/DELEGATE completes **and** IMPROVE is logged.

### Slash command → cycle mapping (agent-skills plugin)
| Slash | Step | | Slash | Step |
|---|---|---|---|---|
| `/spec <feature>` | SPEC | | `/review` | REVIEW |
| `/plan` | PLAN | | `/code-simplify` | SIMPLIFY |
| `/build` | BUILD | | (manual) | IMPROVE |
| `/test` | TEST | | `/ship` | SHIP/DELEGATE |
| | | | (manual) | REPEAT |

Advancement gates: stop and show Omar after `/spec` and after `/plan`; await acknowledgment.
TDD is test-first for vault/storage/cli (CLI adapter tests **mock `Bun.spawn`** — no real CLI
calls in the suite).

---

## Foundation acceptance criteria

- [ ] `bun install` clean from fresh clone; lockfile contains **no** provider SDK
      (`@anthropic-ai/sdk`, `openai`, `@google/generative-ai`, etc.).
- [ ] `bun test` ≥80% line coverage on `vesper-core/src/{vault,storage,cli}` (adapters mock `Bun.spawn`).
- [ ] `bun run lint` (Biome) clean.
- [ ] `vesper init` creates the runtime tree, detects CLIs, writes valid `config.json`.
- [ ] `vesper cli list` prints ≥1 CLI with probe status OK.
- [ ] `vesper hello` returns a real non-empty response via the adapter shell-out (no HTTP client).
- [ ] `vesper status` prints non-error output for all 5 subsystems.
- [ ] `vesper daemon &` then a `ping` over the Unix socket → `{ ok: true, version: "0.1.0" }`.
- [ ] README explains install / init / `vesper hello` and states the bring-your-own-CLI model.
      Mechanics-first; no "Agent OS" framing.

### Foundation out of scope (defer)
Pipelines + pipeline scheduler (Scheduler/DEV-91); paperclip-style capture (Scheduler);
sqlite-vec index (Scheduler); capability enforcement (Scheduler — types only now); ElevenLabs
voice (Voice); Tauri UI (Desktop); Linux/Windows vault backends (later); CI + telemetry (Launch).

---

## Hard rules (non-negotiable)

1. **English only** — code, comments, docs, commits, Linear.
2. **No emojis** in code, commits, docs, or README. (Interactive CLI output may pretty-print.)
3. **OpenSpec format** for Linear issue create/update: Why / What Changes / Impact / Tasks /
   Design Decisions / Spec Deltas / Out of Scope / Acceptance. SHALL + GIVEN/WHEN/THEN where apt.
4. **No silent `rm`** — destructive file ops use a controlled archival pattern.
5. **No "Agent OS" framing** in repo/README/commits — mechanics-first until Desktop.
6. **TypeScript strict, no `any`** — model the domain instead.
7. **Test-first** for vault, storage, cli. (Skip TDD on CLI glue and config wiring.)
8. **Bun-only** — no npm/yarn.
9. **Conventional Commits** (`feat:`, `fix:`, `chore:`, `test:`, `docs:`, `refactor:`).
10. **No CI in Foundation** — local `bun test` is the gate. CI lands in Launch.
11. **No work without a Linear issue** (see Linear section). Halt + surface; never self-create.
12. **No LLM provider SDKs, ever** (see bring-your-own-CLI). All LLM access via CLI shell-out.
13. **Phase names are canonical** — Foundation/Scheduler/Desktop/Voice/Launch, never M1..M5.

---

## Where we are

**Foundation SHIPPED.** PR #3 merged to `main` (merge commit `3f85395`); all seven features and
the epic DEV-86 are Done: vault (DEV-102), storage (DEV-87), cli adapters (DEV-88), vesper-cli
scaffold (DEV-103), vesper hello (DEV-104), ipc stub (DEV-105), README (DEV-106). 113 tests / 0
fail; 100% coverage on vesper-core vault/storage/cli; Biome clean; no provider SDKs. Live smoke
confirmed `init` / `cli list` / `hello` (real claude shell-out) / `status` / `daemon`+`ping` ->
{ok:true, version:"0.1.0"}.

**Now: Scheduler phase (DEV-91 pipeline scheduler) — at the SPEC gate.** DEV-91 (and DEV-89
daemon) still carry pre-pivot content (packages/daemon, croner dep, dollar budget caps tied to
the old LLM router) and need reconciliation + several architecture decisions before BUILD — see
specs/pipeline-scheduler.md. Awaiting Omar's architecture approval; not building yet.

Update this section after each `/ship`.

> `cycle-log.md` (repo root) holds the IMPROVE-step reflections — one entry per completed cycle.
> A separate machine-level memory (claude-mem) handles cross-session user/project memory; this
> file is the repo-specific contract. They coexist — do not merge them.
