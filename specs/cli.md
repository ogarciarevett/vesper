# SPEC: cli adapter module (DEV-88)

## Why

Vesper orchestrates LLM work by shelling out to the user's already-authenticated CLI tool
(`claude`, `opencode`, `codex`, `gemini`). This keeps LLM auth entirely out of Vesper — the
user pays for their own CLI subscription and Vesper composes on top. The `cli/` module provides
the typed adapter layer between Vesper pipelines and those external binaries.

## What changes

- `packages/vesper-core/src/cli/types.ts` — `CLIAdapter` interface and `CompleteResult` type.
- `packages/vesper-core/src/cli/errors.ts` — `CLIError extends VesperError` with reason
  discriminant `"not_installed" | "not_authenticated" | "timeout" | "nonzero_exit"`.
- `packages/vesper-core/src/cli/adapters/claude.ts` — `ClaudeCodeAdapter`.
- `packages/vesper-core/src/cli/adapters/opencode.ts` — `OpenCodeAdapter`.
- `packages/vesper-core/src/cli/adapters/codex.ts` — `CodexAdapter`.
- `packages/vesper-core/src/cli/adapters/gemini.ts` — `GeminiCLIAdapter`.
- `packages/vesper-core/src/cli/detect.ts` — `detectAvailableCLIs`, `selectDefault`.
- `packages/vesper-core/src/cli/registry.ts` — name-to-constructor map for config-driven wiring.
- `packages/vesper-core/src/cli/index.ts` — barrel export for the module.
- `specs/cli.md` — this file.

## Design decisions

- Every adapter takes `{ run?: ProcessRunner; command?: string; args?: readonly string[] }` so
  the CLI layer can override command/args from `~/.vesper/config.json` without the adapters
  knowing about config-file loading. Config loading is the CLI layer's job.
- Default invocations (command + base args; prompt appended as final positional):
  - `claude`: `claude -p`
  - `opencode`: `opencode run`
  - `codex`: `codex exec`
  - `gemini`: `gemini -p`
- `complete(prompt)` builds `argv = [...baseArgs, prompt]`, calls the injected `ProcessRunner`,
  and returns a `CompleteResult`. Error mapping:
  - `CommandNotFoundError` → `CLIError("not_installed")`.
  - `ProcessTimeoutError` → `CLIError("timeout")`.
  - Non-zero exit: stderr matches `/not.*(authenticat|logged in|api key)|unauthorized|login/i`
    → `CLIError("not_authenticated")`; else → `CLIError("nonzero_exit")`.
- `probe()` calls `complete` with the fixed prompt `"respond with the word OK"`. Success resolves;
  any thrown `CLIError` propagates. A zero-exit result (even with empty stdout) is a probe pass.
- `detectAvailableCLIs(run?)` runs `which <bin>` for each known adapter name (claude, opencode,
  codex, gemini) concurrently and returns names where `which` exits 0. A `CommandNotFoundError`
  from `which` itself (i.e. `which` is not on PATH) is treated as all-not-found.
- `selectDefault(installed, configuredDefault?)` returns `configuredDefault` if it is in the
  `installed` list; else the first of `[claude, opencode, codex, gemini]` that is installed;
  else `undefined`.
- Registry maps adapter name → constructor function so the CLI layer can build adapters by name
  from config without importing each adapter directly.

## Impact

Pipelines gain a uniform `CLIAdapter` interface. The CLI layer (`vesper-cli`) uses
`detectAvailableCLIs` + `selectDefault` during `vesper init` and `vesper cli list`. No LLM
provider SDK is introduced; Vesper's bring-your-own-CLI model is preserved.

## Out of scope

- Cost/token tracking and budget caps (Scheduler / DEV-91).
- Streaming output (deferred to Scheduler).
- Tool-use / structured JSON output parsing.
- Config-file loading (`~/.vesper/config.json`); that is the CLI layer's responsibility.
- Linux/Windows `which` equivalents beyond the POSIX `which` binary.

## Acceptance (SHALL)

- GIVEN a mocked `ProcessRunner` that returns `stdout: "hello\n"` WHEN `complete(prompt)` THEN
  returns `CompleteResult` with `{ text: "hello", exit_code: 0 }` and correct timing fields.
- GIVEN the runner throws `CommandNotFoundError` WHEN `complete(prompt)` THEN throws
  `CLIError` with `reason="not_installed"` and `code="cli"`.
- GIVEN the runner throws `ProcessTimeoutError` WHEN `complete(prompt)` THEN throws
  `CLIError` with `reason="timeout"`.
- GIVEN the runner returns `{ exitCode: 1, stderr: "not authenticated" }` WHEN `complete(prompt)`
  THEN throws `CLIError` with `reason="not_authenticated"`.
- GIVEN the runner returns `{ exitCode: 1, stderr: "command failed" }` WHEN `complete(prompt)`
  THEN throws `CLIError` with `reason="nonzero_exit"`.
- GIVEN `which` exits 0 for `claude` and non-zero for others WHEN `detectAvailableCLIs()` THEN
  returns `["claude"]`.
- GIVEN `installed=["opencode","codex"]` and no `configuredDefault` WHEN `selectDefault()` THEN
  returns `"opencode"` (priority order).
- GIVEN `installed=["claude","opencode"]` and `configuredDefault="opencode"` WHEN
  `selectDefault()` THEN returns `"opencode"`.
- GIVEN `installed=["claude"]` and `configuredDefault="gemini"` (not installed) WHEN
  `selectDefault()` THEN returns `"claude"` (fallback to priority).
- `bun test` ≥80% line coverage on `cli/`; adapters tested with mocked `ProcessRunner` only —
  no real CLI invocations.
