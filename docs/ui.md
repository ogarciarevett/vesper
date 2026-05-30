# Vesper World — the visual UI

A local, pixel-art view of your agents. Not a dashboard — a little living world where each
pipeline is a character you can watch and run. Built on the Bun/TypeScript/web stack (Canvas 2D),
served by the daemon on `127.0.0.1`. No Rust/Tauri.

## Run it

```sh
vesper daemon start   # required — the daemon hosts the UI in-process
vesper ui             # opens a browser tab at http://127.0.0.1:4317
```

`vesper ui` refuses if the daemon isn't running (it tells you to start it). Override the port with
`VESPER_UI_PORT`.

## What you see

- **One creature per pipeline**, generated deterministically from this machine (so it's *your*
  world, the same every time). Busier agents are bigger; idle ones rest.
- A **mood glow** from each agent's last run (calm green = ok, amber = needs a look).
- **Click an agent** → a plain-language card: what it last did, how many times it has run, and a big
  **Run** button.
- The world updates **live** as runs happen (manual or scheduled), over a WebSocket.

## How it maps to Vesper

The scene is just a projection of the real runtime — pipelines are inhabitants, the `runs` table is
their visible activity, schedules are their routines. Nothing is faked: it reads the same storage +
scheduler the CLI does, and `Run` calls the same `Scheduler.run` as `vesper schedule run`.

## Modules (extensibility)

The UI has a small module seam (`UiModule`) so capabilities can plug into agents without changing
the core — a planned **Voice** module will let an agent *speak* its result aloud on completion. The
MVP ships the registry with zero modules enabled.

## Privacy

The server binds `127.0.0.1` only (single-user, local, no auth). Run summaries shown in the card
honor `storage.redactRunSummaries`.
