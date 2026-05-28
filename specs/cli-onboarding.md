# SPEC: CLI onboarding — working verification + guided install

> Status: **SPEC gate — awaiting Omar's acknowledgment. Not building yet.**
> Linear: workspace issue-cap'd; this is the SPEC artifact under the Linear-unavailable fallback.
> Reconcile to a DEV issue when the cap lifts. Prompted by Omar's pupila #49/#50 experience.

## Why

`vesper cli list` and `vesper init` today answer "is the binary on PATH?" but not "does it
actually work?" — and when something is wrong, the user is on their own. Two gaps:

1. **Installed != working.** The probe already sends a real prompt, but the failure modes are
   opaque ("timeout"/"nonzero_exit") with no remediation guidance, and the 30 s default timeout
   makes a rate-limited CLI (e.g. gemini) stall `cli list` for half a minute.
2. **No path to install a missing CLI.** If none of the supported four are installed, the user
   has to leave Vesper, find install docs, and come back. We can do better.

This issue tightens the probe, adds remediation hints, ships a guided installer for the four
supported CLIs, and makes `vesper init` redirect when no CLI is working.

## What Changes

### 1. `vesper cli list` shows VERSION + WORKING + REMEDIATION
- Tighten the probe timeout used by the listing path to **8 s** (vs the 30 s default that other
  callers keep). Add an optional `timeoutMs` to `CLIAdapter.probe()`. (Tuned up from 5 s in build
  T6 — 5 s tripped legitimate working CLIs whose round-trip is 4–6 s.)
- Show each CLI's `--version` output alongside the status (fast, no auth, no network).
- Classify probe outcomes and append a one-line remediation:
  | Outcome | Hint |
  |---|---|
  | `not_installed` | `install with \`vesper cli install <name>\`` |
  | `not_authenticated` (existing AUTH_STDERR_RE) | `run \`<cli> login\`` |
  | rate-limited (detect `429` / `RESOURCE_EXHAUSTED` in stderr) | `rate-limited — try later` |
  | timeout at 8 s | `no response (8s) — hung or rate-limited` |
  | `nonzero_exit` | first line of stderr, trimmed |
  | ok | (no hint) |

### 2. `vesper cli install <name>` — guided install for the four supported CLIs
- Adapter registry gains metadata: `installCommand: string`, `installDocsUrl: string`.
- **Already-installed guard (first check, before anything else)**: if `which <name>` succeeds,
  Vesper reports `<name> <version> already installed` and exits cleanly — no command runs, no
  prompts. If the binary is there but not WORKING (auth/quota), that's `vesper cli list`'s job
  to surface, not install's.
- Otherwise (binary missing): prints the **exact command it will run** + the docs link, asks
  for `y/N` confirmation, runs on yes via `Bun.spawn`, then re-probes and reports.
- Curated install commands (Bun-only, per Hard rule 8):
  | CLI | Command |
  |---|---|
  | claude | `curl -fsSL https://claude.ai/install.sh \| bash` (Anthropic's official installer) |
  | codex | `bun add -g @openai/codex` |
  | opencode | `bun add -g opencode-ai` |
  | gemini | `bun add -g @google/gemini-cli` |
  | cursor | `curl https://cursor.com/install -fsS \| bash` (Cursor's official installer; alias `cursor-cli`) |
- **Bun prerequisite check** (runs before any of the above): if `bun` is not on PATH, Vesper
  offers to install it via the official `curl -fsSL https://bun.sh/install \| bash` (separate
  `y/N` confirmation, shown before running). If the user declines, the CLI install aborts with
  a clear message. If accepted, bun is installed, then Vesper proceeds with the chosen CLI's
  command. (In practice this rarely fires — Vesper itself requires bun — but it makes the
  install path complete from a fresh machine and honors Bun-only.)

### 3. `vesper init` redirect when no working CLI
- After detection, if zero CLIs probe as working, `init` prints a one-line redirect:
  `no working CLI found — install one with \`vesper cli install <claude|codex|opencode|gemini>\``.
- Storage + vault still initialize; `init` does not fail.

## Tasks

- [ ] **T1** — `vesper-core/cli`: `CLIAdapter.probe({ timeoutMs? })`; classify probe errors more
  precisely (add `rate_limited` reason; detect `429`/`RESOURCE_EXHAUSTED` in stderr even on
  timeout). Test-first.
- [ ] **T2** — `vesper-core/cli`: `CLIAdapter.version()` returns the first line of `<cli> --version`
  (short timeout, no auth path). Test-first.
- [ ] **T3** — `vesper-cli/commands/cli.ts (list)`: render `name · version · status · hint`; use 5 s
  probe timeout.
- [ ] **T4** — `vesper-cli/commands/cli.ts (install)`: new `install <name>` subcommand. Adapter
  registry metadata table (`installCommand` + `installDocsUrl`). Flow: (0) **already-installed
  guard** — if `which <name>` succeeds, report version + "already installed", exit; (1) **bun
  prerequisite** — if `bun` is missing, offer official `bun.sh/install` curl (separate confirm);
  (2) show command, `y/N` confirm, run, re-probe, report. Interactive TTY only — refuses on
  non-TTY.
- [ ] **T5** — `vesper-cli/commands/init.ts`: post-detection check; print the redirect hint when
  no CLI works.
- [ ] **T6** — Tests >=80% on new code; `biome ci` clean.

## Design Decisions

- **The probe stays a real prompt** (per Omar) — `--version` alone proves "installed", not
  "working". The remediation hint is what fixes the bad-UX gap, not the probe method.
- **Two timeouts, one adapter** — default `probe()` keeps its 30 s for code-path callers; `cli
  list` passes `{ timeoutMs: 5000 }` to avoid stalls. Additive, no breaking change.
- **`curl | bash` is acceptable** because: the URL is HARD-CODED to the vendor's official domain
  over HTTPS, the command is **shown to the user before running**, and confirmation is required.
  This matches how each CLI's own docs publish their installer.
- **Interactive TTY required for `install`** — refuses with a "run interactively" error when
  piped/non-TTY. Matches Vesper's existing TTY discipline (e.g. the REPL gating).

## Out of Scope (deferred / "FOR NOW", per Omar)

- **Auto-install for the Claw family + Hermes** (`open-claw`, `nano-claw`, `iron-claw`, `hermes`).
  These don't have the simple `npm i -g` / `curl | bash` onboarding the four supported CLIs do —
  their setup is bespoke. For now, attempting `vesper cli install <claw-family>` prints docs
  links and a "manual install required" note. Revisit when DEV-98 (Hermes adapter, [M4]) lands.
- `vesper cli login <name>` sugar command — defer. The remediation hint tells the user to run
  `<cli> login` directly; sugar can come later.
- Tampering / signature verification on the install scripts — out of scope; we trust the
  vendor's HTTPS domain, the same as anyone running the published install command by hand.

## Acceptance (SHALL)

- GIVEN `vesper cli list` WHEN any CLI is rate-limited or hung THEN the command returns in **<10 s
  total** (no 30 s gemini stall).
- GIVEN `vesper cli list` WHEN a CLI is not working THEN the row shows a remediation hint that
  tells the user exactly what to do next.
- GIVEN the target CLI's binary is already on PATH WHEN `vesper cli install <name>` is invoked
  THEN it reports `<name> <version> already installed` and exits 0 — NO install command runs.
- GIVEN the target CLI is NOT on PATH AND `vesper cli install <supported-name>` runs in a TTY
  WHEN the user confirms THEN Vesper runs the documented Bun installer (or vendor curl for
  claude), re-probes, and reports the new status.
- GIVEN `vesper cli install <supported-name>` AND `bun` is not on PATH THEN Vesper offers to
  install bun via the official curl (with its own confirmation) BEFORE running the CLI installer;
  declining aborts cleanly.
- GIVEN `vesper cli install <claw|hermes>` THEN Vesper prints docs links + "manual install
  required" and does NOT run anything.
- GIVEN `vesper cli install` on a non-TTY (pipe/CI) THEN it refuses with a clear error.
- GIVEN `vesper init` with zero working CLIs THEN it prints the install-redirect hint and exits 0
  (init still initializes storage/vault).
- `bun test` >=80% on new code; `biome ci` clean.
