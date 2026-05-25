# Vesper

A local-first runtime for personal automation agents. Vesper runs on your machine and hosts
independent automation **pipelines** under one host process — vault, storage, CLI orchestration,
and an IPC surface.

![Vesper: init, a real reply from your own CLI, and a healthy runtime](docs/imgs/demo.gif)

## Bring your own CLI

Vesper does **not** ship or call any LLM provider SDK, and it never holds an API key. Instead it
orchestrates the AI CLI tool you already pay for and have authenticated:

- [`claude`](https://docs.claude.com/en/docs/claude-code) (Claude Code)
- `opencode`
- `codex`
- `gemini`

Vesper shells out to whichever of these you have installed (via `Bun.spawn`) and composes on top
of it. You pay once for your CLI subscription; Vesper adds no per-call billing and stores no
provider credentials. The only secrets Vesper keeps are *pipeline-side* (e.g. a GitHub token),
stored in your OS keychain — never LLM auth.

## Requirements

- [Bun](https://bun.sh) >= 1.1
- macOS (the Foundation vault uses the system Keychain via the `security` CLI)
- At least one installed, authenticated CLI from the list above

## Install

```sh
git clone https://github.com/ogarciarevett/vesper.git
cd vesper
bun install
```

Make the `vesper` command available globally:

```sh
cd packages/vesper-cli && bun link
```

Or run it from the repo without linking:

```sh
bun packages/vesper-cli/src/index.ts <command>
```

## Quick start

```sh
vesper init          # create ~/.vesper, initialize storage, detect installed CLIs
vesper cli list      # show each CLI and its probe status (ok / not-authenticated / not-installed)
vesper hello         # ask your configured CLI to reply — proves orchestration works
vesper status        # versions + health of every subsystem
```

`vesper hello` is the proof that the model works: it sends a fixed prompt to your configured CLI
and prints the reply. No Vesper-held API key is involved — the response comes from your own CLI
subscription, captured over a subprocess pipe.

## Commands

| Command | Description |
|---|---|
| `vesper init` | Create the `~/.vesper` runtime tree, initialize the SQLite store, detect installed CLIs, and write `config.json`. |
| `vesper hello` | Send a fixed prompt to the configured CLI and print the reply. |
| `vesper vault set <key>` | Store a pipeline secret (value read from **stdin**, never the command line). |
| `vesper vault get <key>` | Print a stored secret, or exit non-zero if absent. |
| `vesper vault list` | List stored secret keys (never their values). |
| `vesper cli list` | List supported CLIs and their probe status. |
| `vesper cli select <name>` | Set the default CLI adapter (must be installed). |
| `vesper status` | Show versions and the health of storage, vault, IPC, and the CLI. |
| `vesper daemon` | Run the IPC server (Unix socket at `~/.vesper/run/vesper.sock`). |

Run `vesper <command> --help` for details.

## Configuration

`~/.vesper/config.json`:

```json
{
  "cli": {
    "default": "claude",
    "adapters": {
      "claude": { "command": "claude", "args": ["-p"] }
    }
  }
}
```

`cli.default` selects which CLI `vesper hello` and pipelines use. Per-adapter `command`/`args`
override the default headless invocation if a tool changes its flags.

## Development

```sh
bun test          # run the test suite
bun run lint      # Biome lint + format check
```

The only dependencies are `@biomejs/biome` and Bun's type definitions — no LLM provider SDKs.

## License

MIT.
