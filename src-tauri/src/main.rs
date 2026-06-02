#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod pi_manager;

use pi_manager::{locked_pi_version, wait_for_endpoint, wait_for_health, PiManager};
use serde_json::Value;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;
use tauri::image::Image;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_dialog::MessageDialogKind;

type PiManagerState = Arc<PiManager>;

// ─── Tauri Commands ───────────────────────────────────────────────────────────

/// Create a new session within the current workspace (RPC command to existing pi)
#[tauri::command]
fn cmd_new_session(port: u16, manager: State<PiManagerState>) -> Result<(), String> {
    manager.send_rpc(port, serde_json::json!({ "type": "new_session" }))
}

/// Resume (switch to) an existing session file within the current workspace
#[tauri::command]
fn cmd_switch_session(
    port: u16,
    session_path: String,
    manager: State<PiManagerState>,
) -> Result<(), String> {
    manager.send_rpc(
        port,
        serde_json::json!({ "type": "switch_session", "sessionPath": session_path }),
    )
}

/// Open a workspace directory by spawning a separate pi process.
/// When `open_window` is true (default) a new OS window is opened for the new pi.
/// When false, the pi process is spawned headlessly and the caller is expected to
/// navigate the current window to the returned port.
#[tauri::command]
async fn cmd_open_workspace(
    cwd: String,
    session_path: Option<String>,
    force_new_session: Option<bool>,
    open_window: Option<bool>,
    wait_for_sessions: Option<bool>,
    manager: State<'_, PiManagerState>,
    app: AppHandle,
) -> Result<u16, String> {
    let started_at = Instant::now();
    let port = manager.next_port();
    let spawn_started_at = Instant::now();
    manager.spawn(&cwd, port, session_path.as_deref())?;
    log::info!(
        "[pi-desktop] open_workspace spawn complete: port={} cwd={} elapsed_ms={}",
        port,
        cwd,
        spawn_started_at.elapsed().as_millis()
    );

    // Brief pause then check if the process crashed immediately (fast-fail
    // instead of waiting the full 30-second health timeout).
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    if let Some(status) = manager.check_exited(port) {
        return Err(format!(
            "Pi process exited immediately (port {}, status: {}). \
             Check stderr for crash details.",
            port, status
        ));
    }

    let health_started_at = Instant::now();
    match wait_for_health(port, 30).await {
        Ok(_) => {}
        Err(e) => {
            let extra = if let Some(status) = manager.check_exited(port) {
                format!(" Process has exited with status: {}.", status)
            } else {
                String::new()
            };
            return Err(format!("{}{}", e, extra));
        }
    }
    log::info!(
        "[pi-desktop] open_workspace health ready: port={} elapsed_ms={}",
        port,
        health_started_at.elapsed().as_millis()
    );
    if force_new_session.unwrap_or(false) {
        let new_session_started_at = Instant::now();
        manager.send_rpc(port, serde_json::json!({ "type": "new_session" }))?;
        log::info!(
            "[pi-desktop] open_workspace new_session sent: port={} elapsed_ms={}",
            port,
            new_session_started_at.elapsed().as_millis()
        );
    }
    if wait_for_sessions.unwrap_or(false) {
        let sessions_started_at = Instant::now();
        match wait_for_endpoint(port, "/api/sessions", 4).await {
            Ok(_) => log::info!(
                "[pi-desktop] open_workspace sessions ready: port={} elapsed_ms={}",
                port,
                sessions_started_at.elapsed().as_millis()
            ),
            Err(err) => log::warn!(
                "[pi-desktop] open_workspace sessions warmup skipped: port={} error={}",
                port,
                err
            ),
        }
    }
    if open_window.unwrap_or(true) {
        open_workspace_window(&app, port)?;
    }
    log::info!(
        "[pi-desktop] open_workspace complete: port={} total_elapsed_ms={}",
        port,
        started_at.elapsed().as_millis()
    );
    Ok(port)
}

/// Stop (kill) a pi instance
#[tauri::command]
fn cmd_stop_instance(port: u16, manager: State<PiManagerState>) {
    manager.kill(port);
}

/// Spawn (or reuse) a dedicated pi process for a specific session file so it
/// can run concurrently with the workspace's primary process.
/// Returns the port the dedicated process is listening on.
#[tauri::command]
async fn cmd_spawn_session_process(
    workspace_port: u16,
    session_file: String,
    cwd: String,
    manager: State<'_, PiManagerState>,
) -> Result<u16, String> {
    let port = manager.spawn_session_dedicated(workspace_port, session_file, cwd.as_str())?;
    wait_for_health(port, 15).await?;
    Ok(port)
}

/// Native folder picker dialog
#[tauri::command]
async fn cmd_pick_folder(app: AppHandle) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |path| {
        let result = path.map(|p| match p {
            tauri_plugin_fs::FilePath::Path(pb) => pb.to_string_lossy().into_owned(),
            tauri_plugin_fs::FilePath::Url(url) => url.to_string(),
        });
        let _ = tx.send(result);
    });
    rx.await.ok().flatten()
}

/// Returns the locked pi version embedded in this Pi Studio build
/// (read from `scripts/pi-version.json` at compile time).
#[tauri::command]
fn cmd_get_pi_version() -> Result<String, String> {
    Ok(locked_pi_version().to_string())
}

/// Returns the running Pi Studio app version (the `version` field from
/// `src-tauri/Cargo.toml`, baked in at compile time). Surfaced in the
/// Settings → Updates panel so users can verify what they're running.
#[tauri::command]
fn cmd_get_app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[tauri::command]
fn cmd_is_dev() -> bool {
    cfg!(debug_assertions)
}

#[tauri::command]
fn cmd_open_devtools(port: u16, app: AppHandle) -> Result<(), String> {
    let label = format!("workspace-{}", port);
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("No workspace window found for port {}", port))?;
    window.open_devtools();
    Ok(())
}

// ─── Window helpers ───────────────────────────────────────────────────────────

fn open_workspace_window(app: &AppHandle, port: u16) -> Result<(), String> {
    let label = format!("workspace-{}", port);
    let url = format!("http://localhost:{}", port);
    let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))
        .map_err(|e| format!("Failed to load window icon: {}", e))?;

    WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url.parse().unwrap()))
        .title("Pi Studio")
        .inner_size(1300.0, 860.0)
        .min_inner_size(800.0, 600.0)
        .decorations(true)
        .icon(icon)
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

fn open_bootstrap_window(app: &AppHandle, startup_error: &str) -> Result<(), String> {
    let label = "bootstrap";
    let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))
        .map_err(|e| format!("Failed to load window icon: {}", e))?;
    let encoded_error = startup_error
        .replace('&', "%26")
        .replace(' ', "%20")
        .replace('\n', "%0A");
    let url = format!("bootstrap.html?startupError={}", encoded_error);

    WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title("Pi Studio")
        .inner_size(900.0, 640.0)
        .min_inner_size(700.0, 480.0)
        .decorations(true)
        .icon(icon)
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

fn find_static_dir(app: &tauri::App) -> PathBuf {
    // Release builds: ALWAYS prefer the bundled resource dir. We must check
    // this first because `CARGO_MANIFEST_DIR` is a compile-time string that
    // gets baked into the binary, so on a developer's machine that string
    // still resolves to a real `public/` directory (the repo) and would
    // shadow the bundled resources — making `static_dir.parent()/pi/pi`
    // resolve to `<repo>/pi/pi`, which doesn't exist, with the misleading
    // "run bun run fetch:pi" error.
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("public");
        if bundled.join("index.html").exists() {
            return fs::canonicalize(&bundled).unwrap_or(bundled);
        }
    }

    // Debug builds (`tauri dev`): the bundle isn't assembled yet, so fall
    // back to the repo's `public/`. `CARGO_MANIFEST_DIR` is fine here
    // because debug builds are only ever run on the build machine.
    if cfg!(debug_assertions) {
        let workspace_public = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("public");
        if workspace_public.join("index.html").exists() {
            return fs::canonicalize(&workspace_public).unwrap_or(workspace_public);
        }

        let dev_path = std::env::current_dir().unwrap_or_default().join("public");
        if dev_path.join("index.html").exists() {
            return fs::canonicalize(&dev_path).unwrap_or(dev_path);
        }
        return dev_path;
    }

    // Release build with no resource dir found: return the bundled path
    // anyway so the downstream "could not find pi binary" error points at
    // the actual install location instead of a stale dev path.
    app.path()
        .resource_dir()
        .map(|d| d.join("public"))
        .unwrap_or_else(|_| PathBuf::from("public"))
}

fn list_session_files(root: &PathBuf) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let Ok(entries) = fs::read_dir(root) else {
        return files;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let Ok(inner_entries) = fs::read_dir(path) else {
                continue;
            };
            for inner in inner_entries.flatten() {
                let session_path = inner.path();
                if session_path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
                    files.push(session_path);
                }
            }
        }
    }

    files
}

fn extract_session_cwd(session_path: &PathBuf) -> Option<String> {
    let file = File::open(session_path).ok()?;
    let reader = BufReader::new(file);

    for line in reader.lines().take(200).flatten() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) != Some("session") {
            continue;
        }
        let cwd = value.get("cwd").and_then(Value::as_str)?.trim();
        if cwd.is_empty() {
            return None;
        }
        return Some(cwd.to_string());
    }

    None
}

fn find_latest_session_boot_target() -> Option<(String, String)> {
    let sessions_root = dirs::home_dir()?.join(".pi/agent/sessions");
    if !sessions_root.exists() {
        log::info!(
            "[pi-desktop] startup resume skipped: sessions dir not found at {}",
            sessions_root.display()
        );
        return None;
    }

    let session_files = list_session_files(&sessions_root);
    let latest = session_files
        .into_iter()
        .filter_map(|path| {
            let mtime = fs::metadata(&path).ok()?.modified().ok()?;
            Some((mtime, path))
        })
        .max_by_key(|(mtime, _)| *mtime)?;

    let session_path = latest.1;
    let cwd = extract_session_cwd(&session_path)?;
    Some((cwd, session_path.to_string_lossy().to_string()))
}

#[tauri::command]
async fn cmd_retry_startup(manager: State<'_, PiManagerState>) -> Result<u16, String> {
    let home_cwd = dirs::home_dir()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let (cwd, session_path) = match find_latest_session_boot_target() {
        Some((resolved_cwd, resolved_session_path)) => (resolved_cwd, Some(resolved_session_path)),
        None => (home_cwd, None),
    };
    // Mirror the main setup hook: never adopt a port we don't own. Always
    // claim a fresh one so the resulting pi is driveable via our PiManager.
    let initial_port = manager.next_port();
    manager.spawn(&cwd, initial_port, session_path.as_deref())?;
    wait_for_health(initial_port, 30).await?;
    Ok(initial_port)
}

// ─── Main ─────────────────────────────────────────────────────────────────────

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_log::Builder::new().build())
        .setup(|app| {
            let static_dir = find_static_dir(app);
            let manager = Arc::new(PiManager::new(static_dir));

            let home_cwd = dirs::home_dir()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            let (cwd, session_path) = match find_latest_session_boot_target() {
                Some((resolved_cwd, resolved_session_path)) => {
                    log::info!(
                        "[pi-desktop] startup resume target selected: cwd={} session={}",
                        resolved_cwd, resolved_session_path
                    );
                    (resolved_cwd, Some(resolved_session_path))
                }
                None => {
                    log::info!(
                        "[pi-desktop] startup resume fallback: using home directory {}",
                        home_cwd
                    );
                    (home_cwd, None)
                }
            };

            // Pick the first free port at/above 47821. We deliberately do NOT
            // reuse a port that is already in use, even if "something pi-shaped"
            // is listening on it, because:
            //
            //   1. We can't drive that process: `cmd_new_session` /
            //      `cmd_switch_session` write to *our* `PiManager.processes`
            //      map. A pi we didn't spawn (e.g. left over from an installed
            //      Pi Studio still running, or a previous `bun run dev` whose
            //      Rust side crashed without taking its children with it) is
            //      not in that map, so every RPC fails with
            //      `No pi instance on port <p>` and the UI looks broken.
            //
            //   2. Even if we could control it, the WebView would be talking
            //      to a completely different pi process with a different cwd
            //      and a different session history. That's strictly worse
            //      than starting our own.
            //
            // Allocating a fresh port for *this* Pi Studio instance is the
            // simple invariant that avoids both classes of confusion. The
            // tradeoff is that `http://localhost:47821` is no longer a
            // guaranteed entry point — but Pi Studio doesn't promise that;
            // the WebView discovers its port via the window URL.
            let initial_port = manager.next_port();

            let mut startup_ok = true;
            if initial_port != 47821 {
                log::warn!(
                    "[pi-desktop] port 47821 unavailable, using {} instead (likely another Pi Studio instance is running)",
                    initial_port
                );
            }
            if let Err(err) = manager.spawn(&cwd, initial_port, session_path.as_deref()) {
                startup_ok = false;
                log::error!("[pi-desktop] startup failed to spawn pi: {}", err);
                if let Err(window_err) = open_bootstrap_window(&app.handle().clone(), &err) {
                    log::error!(
                        "[pi-desktop] failed to open bootstrap window after startup error: {}",
                        window_err
                    );
                    app.dialog()
                        .message(format!(
                            "Pi Studio could not start the embedded pi runtime.\n\n{}\n\nThe Pi Studio installation may be incomplete or corrupted. Please reinstall Pi Studio and try again.",
                            err
                        ))
                        .title("Pi Studio startup failed")
                        .kind(MessageDialogKind::Error)
                        .show(|_| {});
                }
            }

            app.manage(manager.clone());

            if startup_ok {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = wait_for_health(initial_port, 30).await {
                        log::error!("Pi failed to start: {}", e);
                    } else if let Err(e) = open_workspace_window(&app_handle, initial_port) {
                        log::error!("Failed to open window: {}", e);
                    }
                });
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let label = window.label();
                if let Some(port_str) = label.strip_prefix("workspace-") {
                    if let Ok(port) = port_str.parse::<u16>() {
                        if let Some(manager) = window.try_state::<PiManagerState>() {
                            manager.kill_workspace_dedicated(port);
                            manager.kill(port);
                        }
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            cmd_new_session,
            cmd_switch_session,
            cmd_open_workspace,
            cmd_stop_instance,
            cmd_pick_folder,
            cmd_get_pi_version,
            cmd_get_app_version,
            cmd_is_dev,
            cmd_open_devtools,
            cmd_retry_startup,
            cmd_spawn_session_process,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle: &tauri::AppHandle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(manager) = app_handle.try_state::<PiManagerState>() {
                    manager.kill_all();
                }
            }
        });
}
