# Vesper World — the visual UI

A local view of your agents. Not a dashboard — a little living world where each pipeline is a
character you can watch and run, and each live external agent (claude/codex/opencode/gemini/zeroclaw)
visits carrying its own brand logo. The default look is **Cozy Cottage** (Hearth-Cottage): a warm
fireside room with soft wool creatures. Built on the Bun/TypeScript/web stack (Canvas 2D), served by
the daemon on `127.0.0.1`. No Rust/Tauri.

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
- A **mood glow** from each agent's last run, plus a gentle, non-alarming "needs a look" state (a
  soft `?` and a worded chip — never a red alarm).
- **Click an agent** → a plain-language card with a portrait of who you tapped, what it last did, how
  many times it has run, and a big **Run** button.
- The world updates **live** as runs happen (manual or scheduled), over a WebSocket.

## Themes (pluggable renderer)

How the world *looks* is a swappable plugin. Each theme draws the same underlying world; the brand
logo of every agent is theme-agnostic, so whichever look you choose, you always see who's who.

- **Cozy Cottage** (`hearth`) — the warm fireside default.
- **Neon City** (`cyberpunk`) — a dark, holographic control-room look (coming next).

Pick a theme by `?theme=<id>` (remembered in the browser), by `vesper ui --theme <id>`, or as the
machine default via `ui.theme` in `~/.vesper/config.json`. Unknown ids fall back to the default.
`prefers-reduced-motion` is honored in every theme.

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
