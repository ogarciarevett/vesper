# SPEC: `vesper skill train` — auto-improve skills via trajectory-driven optimization

> Status: **CORE (slices 1-2) BUILT — module + pipeline green; CLI surface + IMPROVE
> integration deferred.** The pipeline runtime it depends on shipped (see `specs/first-pipeline.md`).
> Built: `packages/vesper-core/src/skill-train/` (skill loader, scorers, optimizer prompt+parse,
> persistence, the epoch-loop `trainSkill`) + `packages/pipelines/skill-train/` (the first
> multi-capability pipeline). 68 tests, biome clean, no provider SDKs. NOT YET built: the
> `vesper skill {train,list,diff,revert}` CLI surface, the cost-confirmation prompt, and the
> user-acked IMPROVE write-back to `.ai/skills/<name>/SKILL.md` (T6, T7) — next increment.
> Linear: workspace issue-cap'd; this is the SPEC artifact under the Linear-unavailable fallback.
> Inspired by Microsoft's SkillOpt (https://github.com/microsoft/SkillOpt) — adapted to Vesper's
> bring-your-own-CLI / no-provider-SDK model.

## Why

The whole `.ai/skills/<name>/SKILL.md` library Vesper ships is *hand-written prose*. There's no
reason those skills should stay static — agent-skills are exactly the artifacts SkillOpt-style
trajectory-driven optimization is designed to improve. This is the *literal Agent-OS moment*:
the OS improves its own playbook, using the user's CLI subscription, with zero Vesper-held
provider keys.

SkillOpt's framing — *train agent skills like you train neural networks: epochs, mini-batches,
learning rates, validation gates — but in text space, without touching model weights* — maps
almost surgically onto Vesper because the SKILL.md substrate already exists and the CLI
adapter layer can carry both the *optimizer* model and the *target* model without breaking
Hard rule 12 (no LLM provider SDKs).

## What Changes (overview)

A new module `packages/vesper-core/src/skill-train/` + a new pipeline `packages/pipelines/
skill-train/` + a CLI surface `vesper skill train <name>`. Together they implement the
SkillOpt loop:

```
load SKILL.md (= s_t, the current best)
for epoch in 1..N:
    sample batch of `tasks.json` items                       (trajectories)
    for each task: response = CLI(s_t + task.prompt)         (target model via adapter)
    optimizer = CLI(meta-prompt + s_t + traces)              (optimizer via adapter)
    candidate s_{t+1} = parse(optimizer.text)
    val_score(s_{t+1}) vs val_score(s_t)                     (gated update)
    if better: s_t := s_{t+1}; checkpoint
write best -> .ai/skills/<name>/SKILL.md (after user-acked IMPROVE)
append cycle-log.md entry
```

## Vesper-specific design

- **No provider SDKs.** Optimizer LLM and target LLM are BOTH invoked through `CLIAdapter.
  complete()`. The user picks adapters per role: `--cli claude --optimizer-cli codex` (defaults
  to the same adapter for both). Lockfile stays SDK-free, Rule 12 preserved.
- **Skills are existing artifacts.** Targets are the current `.ai/skills/<name>/SKILL.md`
  files. The sync-ai pipeline already fans them out to every tool — auto-improve plugs into the
  same substrate. The IMPROVED `SKILL.md` is the deliverable.
- **Invocation = prepend SKILL.md to the prompt.** Vesper doesn't reinvent skill execution; it
  literally passes `SKILL.md + "\n\n---\n" + task.prompt` to `ctx.complete()`. Same path as
  `vesper hello`, same shell-out.
- **Validation harness = `tasks.json` next to each skill.** A simple JSON array of `{ id,
  prompt, expected }` per skill. Scorer options: `exact_match`, `contains`, `judge` (uses a CLI
  as LLM-as-judge — opt-in because it costs another invocation).
- **Persisted state** under `~/.vesper/skill-train/<name>/`: `best.md` (current best),
  `history.jsonl` (one line per epoch: scores, candidate snippet, optimizer/target adapter
  names, model versions, timestamp). The repo-committed `.ai/skills/<name>/SKILL.md` is the
  durable artifact, updated only on user-acked IMPROVE.
- **Trajectory recording.** Each task invocation writes a `runs` row plus a `trajectory.jsonl`
  line under `~/.vesper/skill-train/<name>/epoch-<n>/`. Cheap audit + reproducibility.
- **Cost control.** The implemented loop validates each candidate against the FULL task set, so
  the real per-run call count is `N + epochs*(batchSize + 1 + N)` for `N` tasks (baseline N, then
  per epoch: the batch + 1 optimizer call + N candidate-validation calls). Example: `N=8`,
  `--epochs 2 --batchsize 4` -> `8 + 2*(4+1+8) = 34` calls. The deferred CLI surface (T6) echoes
  this projected count and asks for confirmation before any LLM call. Each call is the user's CLI
  quota (Vesper holds no keys). FUTURE: validate on a held-out subset (T4's original intent) to cut
  the `+N` validation cost and remove train/val overlap.
- **`--dry-run`** prints the proposed candidate without modifying any SKILL.md.

## Hard dependency: pipeline runtime

`skill-train` is itself a pipeline — it uses the **pipeline runtime context** specified in
`specs/first-pipeline.md` (`ctx.complete`, `ctx.recordRun`, capability gates). That contract
must exist before this is buildable. Concretely: `skill-train` declares
`[CLI_INVOKE, READ_STORAGE, WRITE_STORAGE, FS_READ, FS_WRITE]` — the most capabilities of any
pipeline so far, which is exactly why it's the right second pipeline (it stress-tests the
capability model).

## CLI surface

```
vesper skill train <name>                # train, accept improvements after val
  [--epochs N]                            # default 2
  [--batchsize M]                         # default 4
  [--cli <adapter>]                       # target model (default: configured)
  [--optimizer-cli <adapter>]             # optimizer (default: same as --cli)
  [--dry-run]                             # propose; don't write SKILL.md
  [--judge-cli <adapter>]                 # opt-in LLM-as-judge

vesper skill list                         # list trainable skills (those with tasks.json)
vesper skill diff <name>                  # diff committed SKILL.md vs ~/.vesper/.../best.md
vesper skill revert <name>                # restore SKILL.md from history checkpoint
```

## Tasks (rough — full PLAN comes at build time)

- T1 — Skill runtime: `loadSkill(name) -> { body, tasks }`; `runTrajectory(ctx, skill, task)`.
- T2 — Scorers: `exactMatch`, `contains`, `judge(cli)`. Each scorer pure-fn(actual, expected).
- T3 — Optimizer prompt template: given `(skill_body, batch_results, scorer_breakdown)`,
  returns a meta-prompt that asks the LLM to propose a revised skill body.
- T4 — Validation gate: held-out subset; accept candidate iff strictly higher mean score
  (with tie-break: same score, fewer tokens wins).
- T5 — Persistence: `~/.vesper/skill-train/<name>/{best.md, history.jsonl}` + per-epoch
  trajectory files.
- T6 — CLI: `vesper skill {train, list, diff, revert}` subcommands. Confirmation prompt before
  any CLI call.
- T7 — IMPROVE integration: on accepted update, append a `cycle-log.md` entry with the diff
  summary + scores; the `.ai/skills/<name>/SKILL.md` write happens here.
- T8 — Tests >=80% on runtime/scorers/optimizer parsing; `biome ci` clean.

## Design decisions

- **Synthetic `tasks.json` first, real benchmarks later.** SkillOpt ships SearchQA, ALFWorld,
  DocVQA, etc. We start with 10–20 hand-written tasks per skill, mostly to validate the loop.
  Benchmarks can be wired in once the runtime is proven.
- **Skill body = full SKILL.md.** The optimizer rewrites the *whole* SKILL.md each epoch
  (with a constraint to preserve the YAML frontmatter `name`/`description` fields exactly).
  Simpler than diff-mode; tokens are cheap for short skills.
- **Greedy accept (val-strict).** No simulated annealing, no exploration bonus. SkillOpt
  observed this is enough at small `(N, M)`.
- **Determinism where possible.** Pass `--seed` to the optimizer prompt; record the resolved
  model identifier in `history.jsonl`. Best-effort — the underlying CLIs are not always seedable.

## Out of Scope (deferred / "FOR NOW")

- **Benchmark integrations** (SearchQA, ALFWorld, DocVQA, …). Synthetic only at first.
- **Continuous background training.** Manual `vesper skill train <name>` invocation only —
  no scheduler-driven self-training (would be unbounded quota burn). Maybe later as an opt-in
  via the scheduler.
- **Joint cross-skill optimization.** One skill at a time.
- **Curriculum / RL extensions** (multi-step trajectories, reward shaping). Single-step
  prompt → response scoring.
- **Provider-SDK shortcuts.** Hard rule 12 — every LLM call routes through `CLIAdapter.
  complete()`. No exception.
- **Auto-PR / git automation** (e.g. opening a PR with the new SKILL.md). The user reviews the
  diff and commits manually.

## Acceptance (SHALL)

- GIVEN a skill `<name>` with `tasks.json` AND `vesper skill train <name>` runs THEN Vesper
  produces a trajectory log per epoch and an optimizer-proposed candidate `SKILL.md`.
- GIVEN the candidate's mean val score >= baseline mean score (strict tie-break) THEN it is
  accepted: `~/.vesper/skill-train/<name>/best.md` is updated, `history.jsonl` gets a line, and
  the diff is printed. (Writing to `.ai/skills/<name>/SKILL.md` is a *user-acked* IMPROVE step.)
- GIVEN the candidate scores lower THEN it is rejected; `best.md` is unchanged; the rejection
  is logged.
- GIVEN `--dry-run` THEN no on-disk skill is modified.
- GIVEN the pipeline lacks any required capability (`CLI_INVOKE`, `WRITE_STORAGE`, `FS_*`)
  THEN the run is refused before any CLI call (existing DEV-109 enforcement).
- NO new dependency on any LLM provider SDK appears in `bun.lock` after this lands.
- `bun test` >=80% on `skill-train` code; `biome ci` clean.
