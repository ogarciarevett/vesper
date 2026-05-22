# SPEC: vesper-cli scaffold (DEV-103)

## Why
The operator surface. `vesper` is how a human drives the Foundation host: initialize the runtime,
manage pipeline-side secrets, inspect installed CLIs, and read system status. It must be **easy**
(discoverable help, actionable errors, zero-config init), **scalable** (new commands drop in via a
registry, not a growing switch), and **look great** (clean, aligned, scannable output).

## What changes — `packages/vesper-cli/src/`
- **`cli/registry.ts`** — a command-registry/dispatcher. `Command = { name, summary, usage?, run(ctx, argv) }`;
  command *groups* (`vault`, `cli`) hold subcommands. The dispatcher resolves `vesper <group> <sub> ...`,
  routes to `run`, and renders help. New commands register here — no central switch.
- **`cli/args.ts`** — a tiny hand-rolled parser (no commander): splits positionals from `--flag`/`--flag=value`.
- **`cli/ui.ts`** — output helpers: ANSI color/bold/dim + status glyphs (`OK`/`x`/`-`), an aligned
  key/value printer for `status`, and a section printer. Honors `NO_COLOR` and non-TTY (plain output).
- **`config.ts`** — `VesperConfig = { cli: { default?: string; adapters: Record<string, { command?: string; args?: string[] }> } }`;
  `loadConfig()`, `saveConfig(cfg)`, `configPath()`. Hand-rolled parse + narrow (no zod).
- **`paths.ts`** — `vesperHome()` (`~/.vesper`, override via `VESPER_HOME`), `dbPath()`, `configPath()`,
  `socketPath()` (`~/.vesper/run/vesper.sock`), `runDir()`.
- **`commands/`** — `init`, `vault` (set/get/list), `cli` (list/select), `status`, plus `help`.
  (`hello` is DEV-104; `daemon` + the status ipc line are wired when DEV-105 integrates.)

## Command behaviors
- **`vesper init`** — create `~/.vesper/` + `run/`; `openStore(dbPath())` (creates + migrates);
  `detectAvailableCLIs()` -> `selectDefault()`; write `config.json` with the chosen default + adapter
  defaults. Idempotent; prints a short, friendly summary of what was set up.
- **`vesper vault set <key>`** — read the value from **stdin** (never an argv/shell-history leak — the
  vault REVIEW delta), then `KeychainVault.set`. **`get <key>`** prints the value or exits non-zero.
  **`list`** prints keys only.
- **`vesper cli list`** — `detectAvailableCLIs()` + `probe()` each -> aligned table with status
  (`OK` / `not-authenticated` / `not-installed`). **`cli select <name>`** — validate against the
  detected list, set `config.cli.default`.
- **`vesper status`** — aligned report: versions (vesper + Bun), vault, storage (db path/exists),
  ipc socket (added at DEV-105 integration), configured CLI + probe.
- **`vesper` / `vesper --help` / `vesper help`** — registry-generated help; readable top-level + per-command.

## Design decisions
- Thin command handlers over `@vesper/core` APIs; all domain logic stays in core.
- Errors are caught at the dispatcher boundary and printed as one actionable line (the fix), not a
  stack trace; exit code non-zero. `VesperError.code`/`reason` drives the message.
- Output to stdout via a `ui` module (glyphs/color allowed in interactive output; source stays clean,
  no stray `console.log` scattered through logic).
- Skip strict TDD on glue/arg-wiring (per kickoff); unit-test the pure pieces (args parser, config
  load/save round-trip, registry resolution, ui plain-mode) and rely on core module tests beneath.

## Out of scope
`vesper hello` (DEV-104); full `daemon` lifecycle (Scheduler/DEV-89); pipeline commands (Scheduler).

## Acceptance (SHALL)
- `vesper init` creates the tree + a valid `config.json` with a detected default.
- `vault set` (value via stdin) -> `get` round-trips; `list` shows keys, never values.
- `cli list` shows >=1 CLI with probe status; `cli select` rejects an undetected name.
- `vesper status` prints non-error output for available subsystems.
- `vesper --help` (and per-command help) is readable and lists commands with summaries.
- `bun run lint` clean; unit tests green on the pure helpers.
