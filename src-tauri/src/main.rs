#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod broker_ws;
mod pi_manager;

use broker_ws::BrokerWs;
use pi_manager::{
    locked_pi_version, wait_for_endpoint, wait_for_health as wait_for_pi_health, PiManager,
};
use serde_json::Value;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;
use tauri::image::Image;
use tauri::{AppHandle, Manager, State, TitleBarStyle, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_dialog::MessageDialogKind;

type PiManagerState = Arc<PiManager>;
type BrokerWsState = Arc<BrokerWs>;

// ─── Tauri Commands ───────────────────────────────────────────────────────────

/// Create a new session within the current workspace (RPC command to existing pi)
#[tauri::command]
fn cmd_new_session(
    port: u16,
    manager: State<PiManagerState>,
    broker: State<BrokerWsState>,
) -> Result<(), String> {
    let result = manager.send_rpc(port, serde_json::json!({ "type": "new_session" }));
    if result.is_ok() {
        broker.set_active_port(port);
    }
    result
}

/// Resume (switch to) an existing session file within the current workspace
#[tauri::command]
fn cmd_switch_session(
    port: u16,
    session_path: String,
    manager: State<PiManagerState>,
    broker: State<BrokerWsState>,
) -> Result<(), String> {
    let result = manager.send_rpc(
        port,
        serde_json::json!({ "type": "switch_session", "sessionPath": session_path.clone() }),
    );
    if result.is_ok() {
        broker.register_session(port, &session_path);
    }
    result
}

/// Open a workspace directory by spawning a separate pi process.
/// When `open_window` is true (default) a new OS window is opened for the new pi.
/// When false, the pi process is spawned headlessly and the caller is expected to
/// navigate the current window to the returned port.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn cmd_open_workspace(
    cwd: String,
    session_path: Option<String>,
    force_new_session: Option<bool>,
    open_window: Option<bool>,
    wait_for_health: Option<bool>,
    wait_for_sessions: Option<bool>,
    manager: State<'_, PiManagerState>,
    broker: State<'_, BrokerWsState>,
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

    if wait_for_health.unwrap_or(true) {
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
        match wait_for_pi_health(port, 30).await {
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
    }
    // Register with the broker only after the process is confirmed reachable
    // (or, when health checks are skipped, right before we start driving it).
    // Registering earlier would start the upstream reconnect loop against a
    // port that may never come up, leaking a 750ms-interval reconnect spinner
    // on any spawn failure path that returns without unregistering.
    broker.register_session(port, session_path.as_deref().unwrap_or(""));
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
        open_workspace_window(&app, port, &broker.url())?;
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
fn cmd_stop_instance(port: u16, manager: State<PiManagerState>, broker: State<BrokerWsState>) {
    manager.kill(port);
    broker.unregister_port(port);
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
    broker: State<'_, BrokerWsState>,
) -> Result<u16, String> {
    let port =
        manager.spawn_session_dedicated(workspace_port, session_file.clone(), cwd.as_str())?;
    wait_for_pi_health(port, 15).await?;
    // Use track_background_session instead of register_session so the dedicated
    // process is routable by session ID but does NOT become the default
    // active_port — that would silently misroute commands from the session the
    // user is currently viewing.
    broker.track_background_session(port, &session_file);
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

/// A launchable external app target (editor / terminal / file manager).
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AppTarget {
    id: String,
    label: String,
    /// "app" → launched via `open -a <app_name>` (macOS)
    /// "command" → launched via the `command` binary (cross-platform CLI)
    /// "finder" → reveal in the OS file manager
    kind: String,
    app_name: Option<String>,
    command: Option<String>,
}

#[cfg(target_os = "macos")]
fn macos_installed_app_names() -> std::collections::HashSet<String> {
    use std::collections::HashSet;
    let mut roots = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/System/Applications"),
        PathBuf::from("/Applications/Utilities"),
        PathBuf::from("/System/Applications/Utilities"),
    ];
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join("Applications"));
    }
    let mut names = HashSet::new();
    for root in roots {
        let Ok(entries) = fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if path.extension().and_then(|ext| ext.to_str()) != Some("app") {
                continue;
            }
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                names.insert(stem.to_ascii_lowercase());
            }
        }
    }
    names
}

/// List the external apps Pi Studio can open a project in. On macOS this is
/// filtered down to the apps actually installed; on other platforms it falls
/// back to a fixed list of CLI launchers (resolved against PATH at open time).
#[tauri::command]
fn cmd_list_installed_apps() -> Vec<AppTarget> {
    // (id, label, [candidate .app bundle names], cli command)
    let candidates: [(&str, &str, &[&str], &str); 5] = [
        ("vscode", "VS Code", &["Visual Studio Code", "Code"], "code"),
        ("cursor", "Cursor", &["Cursor"], "cursor"),
        ("zed", "Zed", &["Zed"], "zed"),
        ("terminal", "Terminal", &["Terminal", "iTerm", "Warp"], ""),
        ("ghostty", "Ghostty", &["Ghostty"], ""),
    ];

    #[cfg(target_os = "macos")]
    {
        let installed = macos_installed_app_names();
        let mut targets = Vec::new();
        for (id, label, bundle_names, _cmd) in candidates {
            if let Some(app_name) = bundle_names
                .iter()
                .find(|name| installed.contains(&name.to_ascii_lowercase()))
            {
                targets.push(AppTarget {
                    id: id.to_string(),
                    label: label.to_string(),
                    kind: "app".to_string(),
                    app_name: Some((*app_name).to_string()),
                    command: None,
                });
            }
        }
        targets.push(AppTarget {
            id: "finder".to_string(),
            label: "Finder".to_string(),
            kind: "finder".to_string(),
            app_name: None,
            command: None,
        });
        targets
    }

    #[cfg(not(target_os = "macos"))]
    {
        let mut targets: Vec<AppTarget> = candidates
            .iter()
            .filter(|(_, _, _, cmd)| !cmd.is_empty())
            .map(|(id, label, _, cmd)| AppTarget {
                id: id.to_string(),
                label: label.to_string(),
                kind: "command".to_string(),
                app_name: None,
                command: Some(cmd.to_string()),
            })
            .collect();
        targets.push(AppTarget {
            id: "finder".to_string(),
            label: "File Manager".to_string(),
            kind: "finder".to_string(),
            app_name: None,
            command: None,
        });
        targets
    }
}

/// Open a project directory in an external app (editor / terminal / file
/// manager). Mirrors the launch strategy used elsewhere in the workspace:
///   - `app_name` → `open -a <app_name> <path>` on macOS
///   - `command`  → run the CLI binary with the path as the argument
///   - neither    → reveal the path in the OS file manager
#[tauri::command]
fn cmd_open_in_app(
    path: String,
    app_name: Option<String>,
    command: Option<String>,
) -> Result<(), String> {
    use std::process::Command;

    let trimmed_path = path.trim();
    if trimmed_path.is_empty() {
        return Err("Missing path".to_string());
    }

    // CLI command launch (cross-platform): `code <path>`, `cursor <path>`, …
    if let Some(command) = command.as_ref().map(|c| c.trim()).filter(|c| !c.is_empty()) {
        let status = Command::new(command)
            .arg(trimmed_path)
            .status()
            .map_err(|e| format!("Failed to launch `{command}`: {e}"))?;
        if !status.success() {
            return Err(format!("`{command}` exited with status {status}"));
        }
        return Ok(());
    }

    // App launch by bundle name (macOS only).
    if let Some(app_name) = app_name
        .as_ref()
        .map(|a| a.trim())
        .filter(|a| !a.is_empty())
    {
        #[cfg(target_os = "macos")]
        {
            let status = Command::new("open")
                .arg("-a")
                .arg(app_name)
                .arg(trimmed_path)
                .status()
                .map_err(|e| format!("Failed to open `{app_name}`: {e}"))?;
            if !status.success() {
                return Err(format!("`{app_name}` failed to open (status {status})"));
            }
            return Ok(());
        }
        #[cfg(not(target_os = "macos"))]
        {
            let status = Command::new(app_name)
                .arg(trimmed_path)
                .status()
                .map_err(|e| format!("Failed to open `{app_name}`: {e}"))?;
            if !status.success() {
                return Err(format!("`{app_name}` failed to open (status {status})"));
            }
            return Ok(());
        }
    }

    // Fallback: reveal in the OS file manager.
    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg(trimmed_path).status();
    #[cfg(target_os = "windows")]
    let status = Command::new("explorer").arg(trimmed_path).status();
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let status = Command::new("xdg-open").arg(trimmed_path).status();

    status
        .map_err(|e| format!("Failed to reveal path: {e}"))
        .and_then(|s| {
            if s.success() {
                Ok(())
            } else {
                Err(format!("File manager exited with status {s}"))
            }
        })
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

#[tauri::command]
fn cmd_list_pi_packages(manager: State<PiManagerState>) -> Result<Vec<String>, String> {
    manager.list_configured_package_sources()
}

#[tauri::command]
fn cmd_install_pi_package(source: String, manager: State<PiManagerState>) -> Result<(), String> {
    if source.trim().is_empty() {
        return Err("Package source cannot be empty".to_string());
    }
    manager.install_package_source(source.trim())
}

#[tauri::command]
fn cmd_remove_pi_package(source: String, manager: State<PiManagerState>) -> Result<(), String> {
    if source.trim().is_empty() {
        return Err("Package source cannot be empty".to_string());
    }
    manager.remove_package_source(source.trim())
}

// ─── Window helpers ───────────────────────────────────────────────────────────

fn encode_query_value(value: &str) -> String {
    // Encode everything that isn't an unreserved URL character so the value is
    // safe in a query string regardless of its contents.
    percent_encoding::utf8_percent_encode(value, percent_encoding::NON_ALPHANUMERIC).to_string()
}

fn open_workspace_window(app: &AppHandle, port: u16, broker_ws_url: &str) -> Result<(), String> {
    let label = format!("workspace-{}", port);
    let url = format!(
        "http://localhost:{}?brokerWs={}",
        port,
        encode_query_value(broker_ws_url)
    );
    let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))
        .map_err(|e| format!("Failed to load window icon: {}", e))?;

    let builder =
        WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url.parse().unwrap()))
            .title("Pi Studio")
            .inner_size(1300.0, 860.0)
            .min_inner_size(800.0, 600.0)
            .icon(icon)
            .map_err(|e| e.to_string())?;

    // macOS: extend WebView into title bar; traffic lights float on top.
    #[cfg(target_os = "macos")]
    let builder = builder
        .decorations(true)
        .title_bar_style(TitleBarStyle::Overlay)
        .hidden_title(true);

    // Non-macOS: keep standard native decorations.
    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(true);

    builder.build().map_err(|e| e.to_string())?;

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

    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title("Pi Studio")
        .inner_size(900.0, 640.0)
        .min_inner_size(700.0, 480.0)
        .icon(icon)
        .map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    let builder = builder
        .decorations(true)
        .title_bar_style(TitleBarStyle::Overlay)
        .hidden_title(true);

    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(true);

    builder.build().map_err(|e| e.to_string())?;

    Ok(())
}

fn canonical_if_exists(dir: PathBuf) -> Option<PathBuf> {
    if dir.join("index.html").exists() {
        Some(fs::canonicalize(&dir).unwrap_or(dir))
    } else {
        None
    }
}

fn resolve_static_dir(
    resource_dir: Option<PathBuf>,
    workspace_public: PathBuf,
    current_dir: Option<PathBuf>,
    debug_assertions: bool,
) -> PathBuf {
    let bundled_public = resource_dir.as_ref().map(|dir| dir.join("public"));
    let current_public = current_dir.unwrap_or_default().join("public");

    if debug_assertions {
        if let Some(dir) = canonical_if_exists(workspace_public) {
            return dir;
        }
        if let Some(dir) = canonical_if_exists(current_public.clone()) {
            return dir;
        }
        return current_public;
    }

    if let Some(dir) = bundled_public.and_then(canonical_if_exists) {
        return dir;
    }

    resource_dir
        .map(|dir| dir.join("public"))
        .unwrap_or_else(|| PathBuf::from("public"))
}

fn find_static_dir(app: &tauri::App) -> PathBuf {
    resolve_static_dir(
        app.path().resource_dir().ok(),
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("public"),
        std::env::current_dir().ok(),
        cfg!(debug_assertions),
    )
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

#[cfg(test)]
mod tests {
    use super::resolve_static_dir;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_dir(label: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("pi-studio-{label}-{suffix}"))
    }

    #[test]
    fn debug_build_prefers_workspace_public_over_bundled_copy() {
        let root = unique_temp_dir("static-dir-debug");
        let workspace_public = root.join("workspace").join("public");
        let bundled_public = root.join("bundled").join("public");

        fs::create_dir_all(&workspace_public).unwrap();
        fs::create_dir_all(&bundled_public).unwrap();
        fs::write(workspace_public.join("index.html"), "workspace").unwrap();
        fs::write(bundled_public.join("index.html"), "bundled").unwrap();

        let resolved = resolve_static_dir(
            Some(root.join("bundled")),
            workspace_public.clone(),
            Some(root.join("workspace")),
            true,
        );

        assert_eq!(resolved, fs::canonicalize(&workspace_public).unwrap());

        let _ = fs::remove_dir_all(root);
    }
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
async fn cmd_retry_startup(
    manager: State<'_, PiManagerState>,
    broker: State<'_, BrokerWsState>,
) -> Result<u16, String> {
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
    broker.register_session(initial_port, session_path.as_deref().unwrap_or(""));
    if let Err(e) = wait_for_pi_health(initial_port, 30).await {
        // Tear down the upstream reconnect loop started by register_session so it
        // doesn't spin forever against a dead port every 750ms.
        broker.unregister_port(initial_port);
        return Err(e);
    }
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
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .level_for("tokio_tungstenite", log::LevelFilter::Warn)
                .level_for("tungstenite", log::LevelFilter::Warn)
                .level_for("tokio_util", log::LevelFilter::Warn)
                .level_for("hyper", log::LevelFilter::Warn)
                .build(),
        )
        .setup(|app| {
            let static_dir = find_static_dir(app);
            let manager = Arc::new(PiManager::new(static_dir));
            let broker = Arc::new(BrokerWs::start().expect("failed to start broker websocket"));

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
            app.manage(broker.clone());

            if startup_ok {
                broker.register_session(initial_port, session_path.as_deref().unwrap_or(""));
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = wait_for_pi_health(initial_port, 30).await {
                        log::error!("Pi failed to start: {}", e);
                        // Tear down the upstream reconnect loop started by
                        // register_session so it doesn't spin forever against a
                        // dead port every 750ms.
                        if let Some(broker) = app_handle.try_state::<BrokerWsState>() {
                            broker.unregister_port(initial_port);
                        }
                    } else if let Some(broker) = app_handle.try_state::<BrokerWsState>() {
                        if let Err(e) = open_workspace_window(&app_handle, initial_port, &broker.url()) {
                            log::error!("Failed to open window: {}", e);
                        }
                    } else {
                        log::error!("Failed to open window: broker websocket state missing");
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
                        if let Some(broker) = window.try_state::<BrokerWsState>() {
                            broker.unregister_port(port);
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
            cmd_list_installed_apps,
            cmd_open_in_app,
            cmd_get_pi_version,
            cmd_get_app_version,
            cmd_is_dev,
            cmd_open_devtools,
            cmd_list_pi_packages,
            cmd_install_pi_package,
            cmd_remove_pi_package,
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
