# @vesper/desktop

Native desktop shell for Vesper — a deliberately thin [Tauri 2](https://tauri.app) window
whose WebView loads the Bun daemon's "Vesper World" UI. The host runtime stays Bun; this
package adds no business logic. See `specs/tauri-migration.md` and Linear DEV-112.

## Why this exists

For the elder-first Desktop target, "open a browser to `localhost:4317`" is a UX wall.
This shell makes Vesper a double-click native app while reusing the exact same web UI the
daemon already serves (`@vesper/ui`). No Rust in the host — only in this shell.

## Slice 1 (current)

A native window pointed at `http://127.0.0.1:4317`. The daemon is started manually for now;
auto-starting it as a bundled sidecar is Slice 2.

### Run it

```sh
# 1. Toolchain (one-time): Rust + the Tauri CLI.
#    rustup is the supported installer; the Tauri CLI is a devDependency here.

# 2. Start the Bun daemon (hosts Vesper World on 127.0.0.1:4317):
bun run vesper daemon start      # from the repo root

# 3. Launch the native shell (from this package):
bun run dev                      # = tauri dev
```

A native window opens showing Vesper World — click a creature, inspect, Run; live updates
arrive over the same WebSocket the browser uses. No browser involved.

### Build a bundle

```sh
bun run build                    # = tauri build -> .app / .dmg (macOS)
```

## Layout

- `src-tauri/` — the Rust core (window config + entrypoint). Thin by design.
- `src/index.html` — Slice 1 fallback page (becomes the Slice 2 boot splash).

## Not yet (later slices)

Sidecar auto-start + health-wait + attach-to-running-daemon (Slice 2); tray / menu /
notifications (Slice 3); signed installers + auto-updater + CI (Slice 4).
