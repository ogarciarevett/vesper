// Vesper desktop shell — DEV-112 slices 2-3.
//
// A thin native window over the Bun daemon. The Rust core holds no business logic; it:
//   1. spawns the compiled `vesper-daemon` sidecar (serves Vesper World on 127.0.0.1:4317),
//   2. waits for that port to accept connections,
//   3. opens the window onto it,
//   4. stops the sidecar on exit,
// plus native chrome (slice 3): a system tray (Show/Quit) and single-instance focus.
//
// Attach-if-already-running is free: if a daemon is already up (e.g. `vesper daemon
// start`), the sidecar's own single-instance guard makes it exit immediately, the window
// attaches to the running daemon, and on quit we only kill OUR child — never someone
// else's daemon.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{SocketAddr, TcpStream};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

/// Localhost address the daemon serves Vesper World on (matches `uiPort()`'s 4317 default).
const UI_ADDR: &str = "127.0.0.1:4317";
/// URL of the compact menu-bar popover UI (built by the web team, served by the daemon).
const PANEL_URL: &str = "http://127.0.0.1:4317/?panel=1";
/// Borderless popover size (logical pixels) — a quick-glance panel under the tray icon.
const PANEL_WIDTH: f64 = 380.0;
const PANEL_HEIGHT: f64 = 480.0;
/// Gap (physical-ish, scaled at use) between the menu bar / tray icon and the panel top.
const PANEL_GAP: f64 = 6.0;
/// Max time to wait for the daemon to come up before opening the window anyway.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(30);
/// Poll interval while waiting for the daemon's port.
const HEALTH_POLL: Duration = Duration::from_millis(250);

/// Holds the spawned sidecar so it can be stopped on exit. `None` when we attached to an
/// already-running daemon (the spawned child exited via the single-instance guard).
struct Sidecar(Mutex<Option<CommandChild>>);

/// Show and focus the main window if it exists yet (it is created after the health-wait).
fn focus_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Build the hidden borderless popover window pointed at the daemon's compact panel UI.
/// It stays hidden until the tray icon is left-clicked. Returns `Ok(())` even if the
/// daemon is not up yet — the window simply shows blank until the page loads.
fn build_panel(app: &tauri::AppHandle) -> tauri::Result<()> {
    if app.get_webview_window("panel").is_some() {
        return Ok(());
    }
    let window = WebviewWindowBuilder::new(
        app,
        "panel",
        WebviewUrl::External(PANEL_URL.parse().expect("valid panel url")),
    )
    .title("Vesper")
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .visible(false)
    .inner_size(PANEL_WIDTH, PANEL_HEIGHT)
    .build()?;

    // Dismiss-on-click-away: hide the popover the moment it loses focus.
    let dismiss = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Focused(false) = event {
            let _ = dismiss.hide();
        }
    });

    Ok(())
}

/// Toggle the popover relative to the tray icon's on-screen `rect` (physical pixels).
/// If visible, hide it; otherwise anchor its top just below the menu bar, centered under
/// the icon, clamped to the monitor's usable area, then show + focus it.
fn toggle_panel(app: &tauri::AppHandle, tray_rect: tauri::Rect) {
    // Lazily create the panel on first toggle (covers the daemon-not-up-at-setup case).
    if build_panel(app).is_err() {
        return;
    }
    let Some(panel) = app.get_webview_window("panel") else {
        return;
    };

    if panel.is_visible().unwrap_or(false) {
        let _ = panel.hide();
        return;
    }

    position_panel(&panel, tray_rect);
    let _ = panel.show();
    let _ = panel.set_focus();
}

/// Place the popover under the tray icon: horizontally centered on the icon, top edge a
/// small gap below the icon's bottom, clamped to the monitor work area so it never spills
/// off-screen. All math is in physical pixels (the coordinate space `set_position` uses).
fn position_panel(panel: &tauri::WebviewWindow, tray_rect: tauri::Rect) {
    let scale = panel.scale_factor().unwrap_or(1.0);

    // Tray icon rect, normalized to physical pixels.
    let icon_pos = tray_rect.position.to_physical::<f64>(scale);
    let icon_size = tray_rect.size.to_physical::<f64>(scale);
    let icon_center_x = icon_pos.x + icon_size.width / 2.0;
    let icon_bottom_y = icon_pos.y + icon_size.height;

    // Panel outer size in physical pixels (falls back to the configured logical size).
    let (panel_w, panel_h) = match panel.outer_size() {
        Ok(size) => (size.width as f64, size.height as f64),
        Err(_) => (PANEL_WIDTH * scale, PANEL_HEIGHT * scale),
    };

    let mut x = icon_center_x - panel_w / 2.0;
    let mut y = icon_bottom_y + PANEL_GAP * scale;

    // Clamp to the monitor's usable area (work area excludes the menu bar / dock).
    if let Ok(Some(monitor)) = panel.current_monitor() {
        let area = monitor.work_area();
        let min_x = area.position.x as f64;
        let min_y = area.position.y as f64;
        let max_x = min_x + area.size.width as f64 - panel_w;
        let max_y = min_y + area.size.height as f64 - panel_h;
        x = x.clamp(min_x, max_x.max(min_x));
        y = y.clamp(min_y, max_y.max(min_y));
    }

    let _ = panel.set_position(PhysicalPosition::new(x, y));
}

/// Show + focus the main window. Called by the panel UI via `window.__TAURI__`.
#[tauri::command]
fn open_main(app: tauri::AppHandle) {
    focus_main(&app);
}

/// Quit the whole app. Called by the panel UI via `window.__TAURI__`.
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

fn main() {
    tauri::Builder::default()
        // single-instance MUST be the first plugin: a second launch just focuses us.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            focus_main(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .manage(Sidecar(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![open_main, quit_app])
        .setup(|app| {
            // Native chrome (slice 3): a tray icon with Show/Quit. Built on the app's
            // bundled icon; Tauri retains the registered tray for the app's lifetime.
            let show = MenuItem::with_id(app, "show", "Show Vesper", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Vesper", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            TrayIconBuilder::with_id("vesper-tray")
                .icon(app.default_window_icon().expect("bundled app icon").clone())
                .tooltip("Vesper")
                .menu(&menu)
                // Keep the right-click menu (Show/Quit); left-click toggles the popover.
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => focus_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        rect,
                        ..
                    } = event
                    {
                        toggle_panel(tray.app_handle(), rect);
                    }
                })
                .build(app)?;

            // 1. Spawn the compiled daemon sidecar (runs `vesper-daemon daemon run`).
            let (mut rx, child) = app
                .shell()
                .sidecar("vesper-daemon")?
                .args(["daemon", "run"])
                .spawn()?;
            app.state::<Sidecar>().0.lock().unwrap().replace(child);

            // Drain the sidecar's output channel so its stdio pipe never fills and blocks.
            tauri::async_runtime::spawn(async move { while rx.recv().await.is_some() {} });

            // 2 + 3. Wait for the UI port, then open the window onto it (on the main thread).
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let addr: SocketAddr = UI_ADDR.parse().expect("valid UI socket address");
                let deadline = Instant::now() + HEALTH_TIMEOUT;
                while Instant::now() < deadline {
                    if TcpStream::connect_timeout(&addr, HEALTH_POLL).is_ok() {
                        break;
                    }
                    std::thread::sleep(HEALTH_POLL);
                }
                let window_handle = handle.clone();
                let _ = handle.run_on_main_thread(move || {
                    let url = format!("http://{UI_ADDR}");
                    let builder = WebviewWindowBuilder::new(
                        &window_handle,
                        "main",
                        WebviewUrl::External(url.parse().expect("valid UI url")),
                    )
                    .title("Vesper")
                    .inner_size(1180.0, 820.0)
                    .min_inner_size(880.0, 600.0);

                    // macOS-only: frameless/overlay titlebar so the web UI's custom HTML
                    // titlebar shows with the native traffic-light buttons inset over it
                    // (the "native application" look). Windows/Linux are unaffected.
                    #[cfg(target_os = "macos")]
                    let builder = builder
                        .title_bar_style(tauri::TitleBarStyle::Overlay)
                        .hidden_title(true);

                    let _ = builder.build();

                    // Menu-bar popover: a hidden borderless window pointed at the daemon's
                    // compact panel UI. Stays hidden until the tray icon is left-clicked.
                    let _ = build_panel(&window_handle);
                });
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the Vesper desktop shell")
        .run(|app_handle, event| {
            // 4. Stop our sidecar on exit. Never touches an attached (CLI-owned) daemon.
            if let tauri::RunEvent::Exit = event {
                if let Some(child) = app_handle.state::<Sidecar>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}
