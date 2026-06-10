# Vesper World — the visual UI

A local, dark-glass companion app for the Vesper runtime: a chat home where you talk to Vesper
and watch its work live, plus sections for pipelines, connections, schedules, skills, memory,
voice, and diagnostics. Built on the Bun/TypeScript/web stack (vanilla DOM, no framework), served
by the daemon on `127.0.0.1`. No Rust/Tauri.

## Run it

```sh
vesper daemon start   # required — the daemon hosts the UI in-process
vesper ui             # opens a browser tab at http://127.0.0.1:4317
```

`vesper ui` refuses if the daemon isn't running (it tells you to start it). Override the port with
`VESPER_UI_PORT`.

## The chat home

Type a message — Vesper classifies it, answers from the live runtime state (streaming token by
token), or orchestrates pipelines to do the work, authoring every sub-agent prompt itself. The
activity rail on the right shows the run tree live: each completion's PROMPT/RESULT terminal
blocks, provider model badges, and progress steps. The empty state offers a **pipeline launcher**:
pick a pipeline card and the composer is pre-filled with a starter wish.

## Pipelines (the flow editor)

The Pipelines section lists **your saved pipelines** (Run / Edit / New) above the built-ins
(Run + their real prompts under "View template"). The editor is a **drag-and-drop flow canvas**:

- **Drag a step in from the palette, wire outputs to inputs.** An arrow means "runs after, and
  receives the result" (`{{steps.<id>.result}}` in the next prompt). Unconnected steps run at the
  same time; connections that would loop are refused in plain language.
- The canvas shows compact nodes; the full form (prompt with markdown preview, skills, cli +
  model, AI suggestion) appears in the **inspector** only for the selected node.
- A **Canvas / Markdown** toggle shows the whole pipeline as ONE markdown document — the same
  format `vesper pipeline export` emits and `~/.vesper/pipelines/*.md` files use.
- Two step kinds only: a **prompt** and a **pipeline** (one of the orchestratable built-ins).
  No branching, no conditions — the canvas changes how you see and wire the pipeline, not what
  it can do.
- An **orchestrator** (on by default) re-authors downstream prompts from the results so far,
  running on the benchmark frontier pick unless pinned.
- **Permissions are derived, never picked**: a live "what this pipeline can touch" panel updates
  as you edit, and saving shows plain-language capability cards gated by the same single-use
  approval code as template edits.
- **Improve with AI** has Vesper read the whole document and propose prompt rewrites, per-step
  cli+model routing (from the daily benchmark snapshot), and audit warnings — applied only when
  you accept them.
- **Cross-share** is present but disabled (coming soon).

A pipeline is also just a **markdown file**: drop one in `~/.vesper/pipelines/` (filename = id)
and it registers at daemon boot or `vesper pipeline sync`. Everything the editor does works
headlessly first: `vesper pipeline list|show|new|edit|save|run|improve|rm|export|sync` drives the
exact same daemon routes.

## How it maps to Vesper

Nothing is faked: the UI reads the same storage + scheduler the CLI does, Run calls the same
`Scheduler.run` as `vesper schedule run`, and a saved pipeline becomes a real `custom:<id>` task
with its own capability grant. Deleting archives the row — it is never destroyed.

## Privacy

The server binds `127.0.0.1` only (single-user, local, no auth). Privileged mutations (template
edits, pipeline save/delete) additionally require a single-use approval code printed on the
daemon's own terminal. Run summaries honor `storage.redactRunSummaries`.
