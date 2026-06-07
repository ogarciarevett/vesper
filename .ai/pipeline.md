# Vesper Cycle and Working Protocol

> The canonical Vesper development cycle, the parallel-work (Agent Teams) protocol, and the memory
> protocol. The project contract lives in `.ai/context.md`; `bun run sync:ai` assembles both into
> the generated entry files. This is the same cycle Vesper pipelines run autonomously from
> Scheduler onward — building the host by hand is the dogfood pass.

## The canonical Vesper cycle (mandatory for every unit of work)

`SPEC → PLAN → BUILD → TEST → REVIEW → SIMPLIFY → IMPROVE → SHIP/DELEGATE → REPEAT`

1. **SPEC** — declare the unit of work as an OpenSpec proposal at `specs/<feature>.md`.
2. **PLAN** — break the spec into ordered, individually-completable tasks.
3. **BUILD** — produce the artifact, task by task (TDD for vault/storage/cli/scheduler). Any task
   whose diff touches the UI (`packages/vesper-ui/**`) is not done until it passes the impeccable
   UI/UX audit gate — see "UI/UX audit gate (impeccable)" below.
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

A feature is **not done** until SHIP/DELEGATE completes **and** IMPROVE is logged. Every cycle step
transitions the Linear issue and posts a comment — see the "Linear status protocol" in
`.ai/context.md`.

### Slash command → cycle mapping (agent-skills)
| Slash | Step | | Slash | Step |
|---|---|---|---|---|
| `/spec <feature>` | SPEC | | `/review` | REVIEW |
| `/plan` | PLAN | | `/code-simplify` | SIMPLIFY |
| `/build` | BUILD | | (manual) | IMPROVE |
| `/test` | TEST | | `/ship` | SHIP/DELEGATE |
| `$impeccable {audit,critique}` | BUILD: UI gate | | (manual) | REPEAT |

The `/spec`, `/plan`, etc. slashes are Claude Code's agent-skills plugin commands; Codex, Gemini,
and opencode do not share that slash UI but DO run the same skills. Codex auto-discovers skills from
its global `~/.codex/skills/` (`$CODEX_HOME/skills`), so install the `.ai/skills/*` there to use them
in Codex; Gemini and opencode read the materialized `.gemini/`/`.opencode/` copies. Whatever the
tool, the numbered cycle steps above are the cross-tool source of truth.

Advancement gates: stop and show Omar after `/spec` and after `/plan`; await acknowledgment.
TDD is test-first for vault/storage/cli/scheduler (CLI adapter tests **mock the process seam** —
no real CLI calls in the suite; the suite must shell out to nothing).

### UI/UX audit gate (impeccable)

Any BUILD task whose diff touches the UI (`packages/vesper-ui/**`) is **not complete** until it passes
an impeccable UI/UX audit of the surface it changed. This is a sub-step of BUILD (step 3), run per
task — not a separate cycle step. Run **both** Evaluate commands on the changed surface:

- `$impeccable audit <surface>` — technical quality: accessibility, performance, responsive,
  anti-patterns; scored P0-P3.
- `$impeccable critique <surface>` — UX review: visual hierarchy, information architecture, cognitive
  load, heuristics.

Rules:
- The skill is vendored at `.ai/skills/impeccable/` (materialized to the per-tool dirs by
  `bun run sync:ai`). Project context is `docs/PRODUCT.md`; `docs/DESIGN.md` is generated once via
  `$impeccable document` (run it on the first UI task if `DESIGN.md` is still missing, then proceed).
- **P0/P1 findings MUST be fixed before the task counts as done** — loop back within BUILD and
  re-audit. P2/P3 are fixed when cheap, otherwise captured as follow-ups in the IMPROVE reflection.
- **Dark-glass is the committed brand identity** (`docs/PRODUCT.md`) — preserve it; do not let the
  audit's generic "glassmorphism as default" flag strip the intended aesthetic.
- Non-UI tasks (core / cli / storage / scheduler / docs) skip this gate entirely; a cycle with no UI
  changes at all skips it entirely.

---

## Parallel work — Agent Teams (Claude Code) / sub-agents (generic tools)

Same idea, named per tool: in **Claude Code** spin up an **Agent Team** (parallel teammates
coordinating via the shared task list / SendMessage); in **generic agents** (Codex, Gemini,
opencode) launch **sub-agents**. This is the orchestration Foundation and Scheduler were built
with — the lead owns Linear + integration + REVIEW, sub-agents own scoped BUILD.

USE them for:
- independent, file-disjoint slices built in parallel (the Foundation pattern: `vault/`,
  `storage/`, `cli/` built by parallel sub-agents scoped to their own directories);
- the SHIP review fan-out — `code-reviewer` + `security-auditor` + `test-engineer` +
  `performance-reviewer`, each producing an independent report the lead then merges;
- competing-hypothesis debugging (one teammate proves a theory, another tries to break it).

ALWAYS brief each teammate/sub-agent with FRESH, verified context — the relevant `specs/` section,
the actual source files to read, and confirmed library/runtime APIs (not guesses). Each writes
ONLY its own files; the lead then runs integrated `biome ci` + `bun test` + a `/review` pass before
any commit. NO stale info — make them read ground truth.

DON'T use a team for single-file edits, trivial changes, or doc tweaks — the 3-5x token cost is not
worth it; one focused agent is better there. **Sub-agents do not spawn sub-agents** (a Claude Code
platform constraint and a good rule everywhere); orchestration belongs to the lead or a slash
command, never to a persona.

---

## Memory protocol (three coexisting layers — do not merge them)

1. **`.ai/memory.md`** — a LOCAL, per-developer working log shared across the AI CLIs on your
   machine (Claude Code, opencode, Codex, Gemini). It is **gitignored**, seeded from the committed
   template `.ai/memory.example.md` (auto-seeded by `bun run sync:ai`). Referenced via
   `@.ai/memory.md`, never inlined into committed files. APPEND, never rewrite; terse entries,
   newest at the bottom of `## Log`. Shapes: `### [YYYY-MM-DD] build-error` (`symptom → root cause
   → fix`) and `### [YYYY-MM-DD] gotcha` (a runtime/library quirk found the hard way).
2. **claude-mem** — machine-level, cross-session user/project memory (MCP). Not in this repo.
3. **`cycle-log.md`** — committed IMPROVE-step reflections, one entry per completed cycle.

DURABLE, team-facing decisions do NOT go in `.ai/memory.md`. They go in the commit message, the
Linear issue, `cycle-log.md`, and/or a short ADR under `docs/adr/` — reviewed and committed.
`.ai/memory.md` is for ephemeral, per-dev working notes only.

**NEVER write a secret** into `.ai/memory.md` (Keychain values, GitHub tokens, Discord webhooks,
API keys) — even though it is local and gitignored, the example template is committed and the
habit leaks.
