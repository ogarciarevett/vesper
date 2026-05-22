# SPEC: vesper hello (DEV-104)

## Why
The Foundation acceptance demo: prove the orchestration layer works end-to-end without Vesper ever
holding a provider API key or auth token. `vesper hello` invokes the configured default CLI with a
fixed prompt and prints the captured stdout — the proof that "bring-your-own-CLI" works.

## What changes
- New `packages/vesper-cli/src/commands/hello.ts` — `vesper hello`: loadConfig ->
  selectDefault(over detectAvailableCLIs) -> buildAdapter(name).complete(FIXED_PROMPT) -> print text.
- Registered in the command registry.
- FIXED_PROMPT = "Reply with a single sentence confirming you can read this message and identify yourself."

## Design decisions
- Goes through the cli adapter layer (Bun.spawn shell-out) — never an HTTP client or SDK.
- If no CLI is configured/installed, error with the fix (run `vesper init` / `vesper cli select`).
- `complete()` maps failures to CLIError; the dispatcher prints them and exits non-zero.

## Out of scope
Multi-turn, streaming, conversation history (Scheduler+).

## Acceptance (SHALL)
- GIVEN a configured, authenticated CLI WHEN `vesper hello` THEN it prints a real, non-empty
  response captured via the adapter shell-out (no HTTP).
- GIVEN no configured CLI THEN a user-readable error naming the fix; non-zero exit.
