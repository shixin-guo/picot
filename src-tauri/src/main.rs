#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod broker_ws;
mod host_data;
mod host_router;
mod host_server;
mod metadata_store;
mod native_pi_manager;
mod pi_manager;
mod pi_rpc_bridge;
mod remote_auth;
mod runtime_coordinator;
mod settings_store;

use broker_ws::BrokerWs;
use host_server::HostServer;
use metadata_store::MetadataStore;
use native_pi_manager::NativePiManager;
use pi_manager::{
    locked_pi_version, wait_for_endpoint, wait_for_health as wait_for_pi_health, PiManager,
};
use remote_auth::RemoteAuth;
use runtime_coordinator::RuntimeTarget;
use serde_json::Value;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::image::Image;
use tauri::{AppHandle, Manager, State, TitleBarStyle, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_dialog::MessageDialogKind;

type PiManagerState = Arc<PiManager>;
type BrokerWsState = Arc<BrokerWs>;
type NativePiManagerState = NativePiManager;

// ─── Tauri Commands ───────────────────────────────────────────────────────────

/// Create a new session within the current workspace (RPC command to existing pi)
fn new_session_core(port: u16, manager: &PiManager, broker: &BrokerWs) -> Result<(), String> {
    let result = manager.send_rpc(port, serde_json::json!({ "type": "new_session" }));
    if result.is_ok() {
        broker.set_active_port(port);
    }
    result
}

/// Resume (switch to) an existing session file within the current workspace
fn switch_session_core(
    port: u16,
    session_path: &str,
    manager: &PiManager,
    broker: &BrokerWs,
) -> Result<(), String> {
    let result = manager.send_rpc(
        port,
        serde_json::json!({ "type": "switch_session", "sessionPath": session_path }),
    );
    if result.is_ok() {
        broker.register_session(port, session_path);
    }
    result
}

/// Fork the current session from a specific user entry within the workspace.
/// pi handles `fork` natively over its RPC channel (it replaces the active
/// session in-process and emits `session_start { reason: "fork" }`), so we just
/// forward the command to the existing pi like new_session/switch_session do.
/// The process/port is unchanged (fork is in-place), so the active port stays.
fn fork_session_core(
    port: u16,
    entry_id: &str,
    manager: &PiManager,
    broker: &BrokerWs,
) -> Result<(), String> {
    let result = manager.send_rpc(
        port,
        serde_json::json!({ "type": "fork", "entryId": entry_id }),
    );
    if result.is_ok() {
        broker.set_active_port(port);
    }
    result
}

/// Open a workspace directory by spawning a separate pi process.
/// When `open_window` is true (default) a new OS window is opened for the new pi.
/// When false, the pi process is spawned headlessly and the caller is expected to
/// navigate the current window to the returned port.
#[allow(clippy::too_many_arguments)]
async fn open_workspace_core(
    cwd: &str,
    session_path: Option<&str>,
    force_new_session: bool,
    open_window: bool,
    wait_for_health: bool,
    wait_for_sessions: bool,
    manager: &PiManager,
    broker: &BrokerWs,
    app: Option<&AppHandle>,
) -> Result<u16, String> {
    let started_at = Instant::now();
    let port = manager.next_port();
    let spawn_started_at = Instant::now();
    manager.spawn(cwd, port, session_path)?;
    log::info!(
        "[pi-desktop] open_workspace spawn complete: port={} cwd={} elapsed_ms={}",
        port,
        cwd,
        spawn_started_at.elapsed().as_millis()
    );

    if wait_for_health {
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
    broker.register_session(port, session_path.unwrap_or(""));
    if force_new_session {
        let new_session_started_at = Instant::now();
        manager.send_rpc(port, serde_json::json!({ "type": "new_session" }))?;
        log::info!(
            "[pi-desktop] open_workspace new_session sent: port={} elapsed_ms={}",
            port,
            new_session_started_at.elapsed().as_millis()
        );
    }
    if wait_for_sessions {
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
    if open_window {
        if let Some(app) = app {
            open_workspace_window(app, port, &broker.url())?;
        } else {
            log::warn!(
                "[pi-desktop] open_workspace requested a window but no AppHandle is available (port {})",
                port
            );
        }
    }
    log::info!(
        "[pi-desktop] open_workspace complete: port={} total_elapsed_ms={}",
        port,
        started_at.elapsed().as_millis()
    );
    Ok(port)
}

/// Stop (kill) a pi instance
fn stop_instance_core(port: u16, manager: &PiManager, broker: &BrokerWs) {
    manager.kill(port);
    broker.unregister_port(port);
}

/// Spawn (or reuse) a dedicated pi process for a specific session file so it
/// can run concurrently with the workspace's primary process.
/// Returns the port the dedicated process is listening on.
async fn spawn_session_process_core(
    workspace_port: u16,
    session_file: &str,
    cwd: &str,
    manager: &PiManager,
    broker: &BrokerWs,
) -> Result<u16, String> {
    let port = manager.spawn_session_dedicated(workspace_port, session_file.to_string(), cwd)?;
    wait_for_pi_health(port, 15).await?;
    // Use track_background_session instead of register_session so the dedicated
    // process is routable by session ID but does NOT become the default
    // active_port — that would silently misroute commands from the session the
    // user is currently viewing.
    broker.track_background_session(port, session_file);
    Ok(port)
}

/// Native folder picker dialog
async fn pick_folder_core(app: &AppHandle) -> Option<String> {
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

/// List the external apps Picot can open a project in. On macOS this is
/// filtered down to the apps actually installed; on other platforms it falls
/// back to a fixed list of CLI launchers (resolved against PATH at open time).
fn list_installed_apps_core() -> Vec<AppTarget> {
    // (id, label, [candidate .app bundle names], cli command)
    let candidates: [(&str, &str, &[&str], &str); 6] = [
        ("vscode", "VS Code", &["Visual Studio Code", "Code"], "code"),
        ("cursor", "Cursor", &["Cursor"], "cursor"),
        (
            "webstorm",
            "WebStorm",
            &["WebStorm", "WebStorm EAP"],
            "webstorm",
        ),
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
fn open_in_app_core(
    path: &str,
    app_name: Option<&str>,
    command: Option<&str>,
) -> Result<(), String> {
    use std::process::Command;

    let trimmed_path = path.trim();
    if trimmed_path.is_empty() {
        return Err("Missing path".to_string());
    }

    // CLI command launch (cross-platform): `code <path>`, `cursor <path>`, …
    if let Some(command) = command.map(|c| c.trim()).filter(|c| !c.is_empty()) {
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
    if let Some(app_name) = app_name.map(|a| a.trim()).filter(|a| !a.is_empty()) {
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

fn open_devtools_core(port: u16, app: &AppHandle) -> Result<(), String> {
    let label = format!("workspace-{}", port);
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("No workspace window found for port {}", port))?;
    window.open_devtools();
    Ok(())
}

/// Open a URL in the user's default system browser. Uses the platform opener
/// (`open` / `start` / `xdg-open`) directly so we don't depend on the
/// deprecated shell-plugin `open`.
fn open_external_core(url: &str) -> Result<(), String> {
    use std::process::Command;

    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("Missing URL".to_string());
    }

    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg(trimmed).status();
    #[cfg(target_os = "windows")]
    let status = Command::new("cmd")
        .args(["/C", "start", "", trimmed])
        .status();
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let status = Command::new("xdg-open").arg(trimmed).status();

    status
        .map_err(|e| format!("Failed to open URL: {e}"))
        .and_then(|s| {
            if s.success() {
                Ok(())
            } else {
                Err(format!("Opener exited with status {s}"))
            }
        })
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
            .title("Picot")
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

fn open_native_workspace_window(
    app: &AppHandle,
    host_origin: &str,
    target: &RuntimeTarget,
) -> Result<(), String> {
    let label = format!("native-workspace-{}", target.workspace_id);
    let url = format!(
        "{}/app/workspaces/{}/sessions/{}",
        host_origin, target.workspace_id, target.session_id
    );
    let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))
        .map_err(|error| format!("Failed to load window icon: {error}"))?;
    let builder = WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::External(
            url.parse()
                .map_err(|error| format!("Invalid native Host URL: {error}"))?,
        ),
    )
    .title("Picot")
    .inner_size(1300.0, 860.0)
    .min_inner_size(800.0, 600.0)
    .icon(icon)
    .map_err(|error| error.to_string())?;

    #[cfg(target_os = "macos")]
    let builder = builder
        .decorations(true)
        .title_bar_style(TitleBarStyle::Overlay)
        .hidden_title(true);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(true);
    builder.build().map_err(|error| error.to_string())?;
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
        .title("Picot")
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

fn select_fresh_startup_target(
    home_cwd: String,
    latest_session: Option<(String, String)>,
) -> (String, Option<String>) {
    let cwd = latest_session
        .map(|(session_cwd, _session_path)| session_cwd)
        .unwrap_or(home_cwd);
    (cwd, None)
}

fn native_runtime_enabled() -> bool {
    cfg!(debug_assertions)
        && std::env::var("PICOT_RUNTIME").is_ok_and(|value| value.eq_ignore_ascii_case("native"))
}

fn setup_native_runtime(app: &mut tauri::App, static_dir: PathBuf) -> Result<(), String> {
    let home_cwd = dirs::home_dir()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let (cwd, session_path) =
        select_fresh_startup_target(home_cwd, find_latest_session_boot_target());
    let metadata_path = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Cannot resolve Picot app data directory: {error}"))?
        .join("picot.sqlite3");
    let mut metadata = MetadataStore::open(&metadata_path)?;
    let workspace_id = metadata.workspace_id_for_path(std::path::Path::new(&cwd))?;
    let session_id = format!("temporary-{}", uuid::Uuid::new_v4().simple());
    let target = RuntimeTarget::new(
        workspace_id,
        session_id,
        format!("instance-{}", uuid::Uuid::new_v4().simple()),
    );
    let resolver = PiManager::new(static_dir.clone());
    let launch = resolver.native_launch_spec(&cwd, session_path.as_deref())?;
    let runtimes = NativePiManager::new(256);
    let remote_auth = Arc::new(Mutex::new(RemoteAuth::new(metadata)));
    let host = tauri::async_runtime::block_on(HostServer::start_with_workspaces(
        static_dir,
        runtimes.clone(),
        remote_auth,
        std::collections::HashMap::from([(target.workspace_id.clone(), PathBuf::from(&cwd))]),
    ))?;
    runtimes.spawn(target.clone(), launch)?;
    if let Err(error) = open_native_workspace_window(app.handle(), host.origin(), &target) {
        runtimes.stop_all();
        return Err(error);
    }
    log::info!(
        "[picot-native] started workspace_id={} session_id={} instance_id={} origin={}",
        target.workspace_id,
        target.session_id,
        target.instance_id,
        host.origin()
    );
    app.manage(runtimes);
    app.manage(host);
    Ok(())
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
    let (cwd, session_path) =
        select_fresh_startup_target(home_cwd, find_latest_session_boot_target());
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

// ─── Auto-updater cores ─────────────────────────────────────────────────────

/// Check GitHub for a newer release. Returns update metadata as JSON, or
/// `Value::Null` when already up to date. Mirrors the shape the old JS
/// `checkForUpdate` returned so the frontend renderer is unchanged.
async fn check_for_update_core(app: &AppHandle) -> Result<Value, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await.map_err(|e| e.to_string())? {
        Some(update) => Ok(serde_json::json!({
            "available": true,
            "version": update.version,
            "currentVersion": update.current_version,
            "date": update.date.map(|d| d.to_string()),
            "notes": update.body.clone().unwrap_or_default(),
        })),
        None => Ok(Value::Null),
    }
}

/// Download + install the available update, streaming progress frames through
/// `progress` (broker → client). Replaces the Tauri `Channel` the JS used.
async fn download_and_install_update_core(
    app: &AppHandle,
    progress: broker_ws::ProgressSink,
) -> Result<Value, String> {
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::Arc;
    use tauri_plugin_updater::UpdaterExt;

    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = match updater.check().await.map_err(|e| e.to_string())? {
        Some(update) => update,
        None => return Ok(serde_json::json!({ "installed": false, "reason": "no_update" })),
    };
    let version = update.version.clone();

    let downloaded = Arc::new(AtomicU64::new(0));
    let started = Arc::new(AtomicBool::new(false));
    let chunk_sink = progress.clone();
    let dl = downloaded.clone();
    let started_flag = started.clone();
    let finish_sink = progress.clone();

    update
        .download_and_install(
            move |chunk_length, content_length| {
                let total =
                    dl.fetch_add(chunk_length as u64, Ordering::Relaxed) + chunk_length as u64;
                if !started_flag.swap(true, Ordering::Relaxed) {
                    chunk_sink(serde_json::json!({
                        "phase": "started",
                        "contentLength": content_length,
                    }));
                }
                chunk_sink(serde_json::json!({
                    "phase": "progress",
                    "downloaded": total,
                    "contentLength": content_length,
                }));
            },
            move || {
                finish_sink(serde_json::json!({ "phase": "finished" }));
            },
        )
        .await
        .map_err(|e| e.to_string())?;

    Ok(serde_json::json!({ "installed": true, "version": version }))
}

// ─── Broker control handler ──────────────────────────────────────────────────

/// Resolve a control command's target port: prefer the explicit port from the
/// request, else fall back to the broker's active port.
fn resolve_control_port(port: Option<u16>, broker: &BrokerWs) -> Result<u16, String> {
    if let Some(port) = port {
        return Ok(port);
    }
    // No explicit target. Falling back to the global active_port is only safe
    // when a single pi process is live; with several (multi-window) it belongs
    // to whichever window registered last, so a lifecycle op (new_session /
    // switch_session / stop_instance) could land on the wrong workspace (F4).
    if broker.live_upstream_count() > 1 {
        return Err(
            "Ambiguous target: multiple pi instances are running; a port must be specified"
                .to_string(),
        );
    }
    broker
        .active_port()
        .ok_or_else(|| "No active pi instance".to_string())
}

/// Build + install the async handler the broker uses to execute `broker_control`
/// requests from ANY client (desktop WebView, remote, mobile). It maps command
/// names to the same cores the rest of the app uses, so behavior is identical
/// regardless of transport. Native ops (folder picker, devtools, updater,
/// open-in-app/external) require an OS host and are only meaningful when this
/// handler is installed — which is exactly what `capabilities.native` advertises.
fn install_control_handler(broker: &Arc<BrokerWs>, manager: Arc<PiManager>, app: AppHandle) {
    let broker_for_handler = broker.clone();
    let handler: broker_ws::ControlHandler = Arc::new(
        move |command: String, args: Value, progress: broker_ws::ProgressSink| {
            let manager = manager.clone();
            let broker = broker_for_handler.clone();
            let app = app.clone();
            Box::pin(async move {
                let arg = |key: &str| args.get(key).cloned().unwrap_or(Value::Null);
                let arg_str = |key: &str| arg(key).as_str().map(|s| s.to_string());
                let arg_u16 = |key: &str| {
                    args.get(key)
                        .and_then(Value::as_u64)
                        .and_then(|n| u16::try_from(n).ok())
                };
                let arg_bool = |key: &str| args.get(key).and_then(Value::as_bool);

                match command.as_str() {
                    "open_workspace" => {
                        let cwd = arg_str("cwd").ok_or("cwd is required")?;
                        let session_path = arg_str("sessionPath");
                        let port = open_workspace_core(
                            &cwd,
                            session_path.as_deref(),
                            arg_bool("forceNewSession").unwrap_or(false),
                            arg_bool("openWindow").unwrap_or(true),
                            arg_bool("waitForHealth").unwrap_or(true),
                            arg_bool("waitForSessions").unwrap_or(false),
                            &manager,
                            &broker,
                            Some(&app),
                        )
                        .await?;
                        Ok(Value::from(port))
                    }
                    "new_session" => {
                        let port = resolve_control_port(arg_u16("port"), &broker)?;
                        new_session_core(port, &manager, &broker)?;
                        Ok(Value::Null)
                    }
                    "switch_session" => {
                        let session_path =
                            arg_str("sessionPath").ok_or("sessionPath is required")?;
                        let port = resolve_control_port(arg_u16("port"), &broker)?;
                        switch_session_core(port, &session_path, &manager, &broker)?;
                        Ok(Value::Null)
                    }
                    "fork" => {
                        let entry_id = arg_str("entryId").ok_or("entryId is required")?;
                        let port = resolve_control_port(arg_u16("port"), &broker)?;
                        fork_session_core(port, &entry_id, &manager, &broker)?;
                        Ok(Value::Null)
                    }
                    "stop_instance" => {
                        let port = resolve_control_port(arg_u16("port"), &broker)?;
                        stop_instance_core(port, &manager, &broker);
                        Ok(Value::Null)
                    }
                    "spawn_session_process" => {
                        let session_file =
                            arg_str("sessionFile").ok_or("sessionFile is required")?;
                        let cwd = arg_str("cwd").ok_or("cwd is required")?;
                        let workspace_port =
                            resolve_control_port(arg_u16("workspacePort"), &broker)?;
                        let port = spawn_session_process_core(
                            workspace_port,
                            &session_file,
                            &cwd,
                            &manager,
                            &broker,
                        )
                        .await?;
                        Ok(Value::from(port))
                    }
                    "get_pi_version" => Ok(Value::from(locked_pi_version())),
                    "get_app_version" => Ok(Value::from(env!("CARGO_PKG_VERSION"))),
                    "is_dev" => Ok(Value::from(cfg!(debug_assertions))),
                    "pick_folder" => Ok(match pick_folder_core(&app).await {
                        Some(path) => Value::from(path),
                        None => Value::Null,
                    }),
                    "list_installed_apps" => {
                        Ok(serde_json::to_value(list_installed_apps_core()).unwrap_or(Value::Null))
                    }
                    "open_in_app" => {
                        let path = arg_str("path").ok_or("path is required")?;
                        let app_name = arg_str("appName");
                        let command = arg_str("command");
                        open_in_app_core(&path, app_name.as_deref(), command.as_deref())?;
                        Ok(Value::Null)
                    }
                    "open_external" => {
                        let url = arg_str("url").ok_or("url is required")?;
                        open_external_core(&url)?;
                        Ok(Value::Null)
                    }
                    "open_devtools" => {
                        let port = resolve_control_port(arg_u16("port"), &broker)?;
                        open_devtools_core(port, &app)?;
                        Ok(Value::Null)
                    }
                    "list_pi_packages" => {
                        let sources = manager.list_configured_package_sources()?;
                        Ok(serde_json::to_value(sources).unwrap_or(Value::Null))
                    }
                    "install_pi_package" => {
                        let source = arg_str("source").unwrap_or_default();
                        if source.trim().is_empty() {
                            return Err("Package source cannot be empty".to_string());
                        }
                        manager.install_package_source(source.trim())?;
                        Ok(Value::Null)
                    }
                    "remove_pi_package" => {
                        let source = arg_str("source").unwrap_or_default();
                        if source.trim().is_empty() {
                            return Err("Package source cannot be empty".to_string());
                        }
                        manager.remove_package_source(source.trim())?;
                        Ok(Value::Null)
                    }
                    "check_for_update" => check_for_update_core(&app).await,
                    "download_and_install_update" => {
                        download_and_install_update_core(&app, progress).await
                    }
                    "relaunch_app" => app.restart(),
                    other => Err(format!("Unknown control command: {other}")),
                }
            })
        },
    );
    broker.set_control_handler(handler);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

fn main() {
    // Sync PATH from the user's login shell before anything else.
    // macOS GUI apps (launched from Finder/Dock) inherit only the minimal
    // system PATH (/usr/bin:/bin:/usr/sbin:/sbin).  fix_path_env::fix() runs
    // the user's login shell and merges its environment into this process so
    // that all child processes (pi binary, npm, git, …) see the same tools
    // as a normal terminal session.
    if let Err(err) = fix_path_env::fix() {
        eprintln!("[picot] failed to sync PATH from login shell: {err}");
    }

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
            if native_runtime_enabled() {
                setup_native_runtime(app, static_dir).map_err(std::io::Error::other)?;
                return Ok(());
            }
            let manager = Arc::new(PiManager::new(static_dir));
            let broker = Arc::new(BrokerWs::start().expect("failed to start broker websocket"));
            std::env::set_var("PI_STUDIO_BROKER_PORT", broker.port().to_string());
            install_control_handler(&broker, manager.clone(), app.handle().clone());

            let home_cwd = dirs::home_dir()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            let (cwd, session_path) =
                select_fresh_startup_target(home_cwd, find_latest_session_boot_target());
            log::info!(
                "[pi-desktop] fresh startup session selected for cwd={}",
                cwd
            );

            // Pick the first free port at/above 47821. We deliberately do NOT
            // reuse a port that is already in use, even if "something pi-shaped"
            // is listening on it, because:
            //
            //   1. We can't drive that process: `cmd_new_session` /
            //      `cmd_switch_session` write to *our* `PiManager.processes`
            //      map. A pi we didn't spawn (e.g. left over from an installed
            //      Picot still running, or a previous `bun run dev` whose
            //      Rust side crashed without taking its children with it) is
            //      not in that map, so every RPC fails with
            //      `No pi instance on port <p>` and the UI looks broken.
            //
            //   2. Even if we could control it, the WebView would be talking
            //      to a completely different pi process with a different cwd
            //      and a different session history. That's strictly worse
            //      than starting our own.
            //
            // Allocating a fresh port for *this* Picot instance is the
            // simple invariant that avoids both classes of confusion. The
            // tradeoff is that `http://localhost:47821` is no longer a
            // guaranteed entry point — but Picot doesn't promise that;
            // the WebView discovers its port via the window URL.
            let initial_port = manager.next_port();

            let mut startup_ok = true;
            if initial_port != 47821 {
                log::warn!(
                    "[pi-desktop] port 47821 unavailable, using {} instead (likely another Picot instance is running)",
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
                            "Picot could not start the embedded pi runtime.\n\n{}\n\nThe Picot installation may be incomplete or corrupted. Please reinstall Picot and try again.",
                            err
                        ))
                        .title("Picot startup failed")
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
                if let Some(workspace_id) = label.strip_prefix("native-workspace-") {
                    if let Some(manager) = window.try_state::<NativePiManagerState>() {
                        manager.stop_workspace(workspace_id);
                    }
                    return;
                }
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
        // The main UI talks to the host exclusively over the broker WebSocket
        // (`broker_control`); the only remaining Tauri IPC command is
        // `cmd_retry_startup`, used by the native bootstrap error window
        // (bootstrap.html) which is not part of the decoupled web UI.
        .invoke_handler(tauri::generate_handler![cmd_retry_startup])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle: &tauri::AppHandle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(manager) = app_handle.try_state::<NativePiManagerState>() {
                    manager.stop_all();
                }
                if let Some(manager) = app_handle.try_state::<PiManagerState>() {
                    manager.kill_all();
                }
            }
        });
}

#[cfg(test)]
mod startup_tests {
    use super::select_fresh_startup_target;

    #[test]
    fn keeps_the_latest_workspace_but_never_resumes_its_session_on_app_start() {
        let selected = select_fresh_startup_target(
            "/home/user".to_string(),
            Some((
                "/work/project".to_string(),
                "/sessions/old-session.jsonl".to_string(),
            )),
        );

        assert_eq!(selected, ("/work/project".to_string(), None));
    }
}
