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
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

/// Localhost address the daemon serves Vesper World on (matches `uiPort()`'s 4317 default).
const UI_ADDR: &str = "127.0.0.1:4317";
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

fn main() {
    tauri::Builder::default()
        // single-instance MUST be the first plugin: a second launch just focuses us.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            focus_main(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .manage(Sidecar(Mutex::new(None)))
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
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => focus_main(app),
                    "quit" => app.exit(0),
                    _ => {}
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
