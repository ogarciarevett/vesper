// Vesper desktop shell — DEV-112 Slice 2.
//
// A thin native window over the Bun daemon. The Rust core does four things and holds no
// business logic: (1) spawns the compiled `vesper-daemon` sidecar (which serves Vesper
// World on 127.0.0.1:4317), (2) waits for that port to accept connections, (3) opens the
// window onto it, and (4) stops the sidecar on exit.
//
// Attach-if-already-running is free: if a daemon is already up (e.g. `vesper daemon
// start`), the sidecar's own single-instance guard makes it exit immediately, the window
// attaches to the running daemon, and on quit we only kill OUR child — never someone
// else's daemon.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{SocketAddr, TcpStream};
use std::sync::Mutex;
use std::time::{Duration, Instant};

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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(Sidecar(Mutex::new(None)))
        .setup(|app| {
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
                    let _ = WebviewWindowBuilder::new(
                        &window_handle,
                        "main",
                        WebviewUrl::External(url.parse().expect("valid UI url")),
                    )
                    .title("Vesper")
                    .inner_size(1180.0, 820.0)
                    .min_inner_size(880.0, 600.0)
                    .build();
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
