#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// ABOUTME: Picot Tauri host entry point: spawns per-workspace Pi processes and
// ABOUTME: owns windows, the broker, ephemeral chats, and the native close lifecycle.

mod broker_ws;
mod host_data;
mod host_router;
mod host_server;
mod metadata_store;
mod native_pi_manager;
// Public API staged for the broker (Task 5) and host lifecycle (Task 7a).
#[allow(dead_code)]
mod command_policy;
mod ephemeral_registry;
mod pi_manager;
mod pi_rpc_bridge;
mod remote_auth;
mod runtime_coordinator;
mod settings_store;
mod window_owner;

use broker_ws::BrokerWs;
use ephemeral_registry::{
    CleanupLease, CreateReservation, EphemeralKind, EphemeralRegistry, EphemeralUiPatch,
    OwnedProcess,
};
use host_server::HostServer;
use metadata_store::MetadataStore;
use native_pi_manager::NativePiManager;
use pi_manager::{
    build_ephemeral_environment, canonical_temp_root, cleanup_quick_chat_dir,
    create_quick_chat_temp_dir, locked_pi_version, wait_for_endpoint,
    wait_for_health as wait_for_pi_health, PiManager, PiSpawnSpec,
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
use window_owner::WindowOwnerRegistry;

type PiManagerState = Arc<PiManager>;
type BrokerWsState = Arc<BrokerWs>;
type NativePiManagerState = NativePiManager;
#[allow(dead_code)]
type OwnerRegistryState = Arc<WindowOwnerRegistry>;
#[allow(dead_code)]
type EphemeralRegistryState = Arc<EphemeralRegistry>;

// ─── Tauri Commands ───────────────────────────────────────────────────────────

/// Create a new session within the current workspace (RPC command to existing pi)
fn new_session_core(port: u16, manager: &PiManager, broker: &BrokerWs) -> Result<(), String> {
    let result = manager.send_rpc(port, serde_json::json!({ "type": "new_session" }));
    if result.is_ok() {
        broker.set_active_port(port);
    }
    result
}

/// Ask the Pi instance at `port` for its available models. The response lands
/// on stdout and is captured by the RPC output subscriber loop, which stores
/// it in the shared model cache. Called once per session registration so the
/// cache is populated by the time any Side Chat / Quick Chat / new session
/// needs to render a model dropdown.
fn warm_model_cache(manager: &PiManager, port: u16) {
    if manager.cached_models().is_some() {
        return; // already populated by an earlier session
    }
    let cmd = serde_json::json!({ "type": "get_available_models" });
    if let Err(e) = manager.send_rpc(port, cmd) {
        log::warn!("[pi-desktop] model cache warm-up rpc failed: {}", e);
    }
}

/// Pre-spawn a Side Chat standby pi so the next "New Side Chat" feels
/// instant. The standby uses the workspace cwd and keeps tools enabled.
/// It's parked in the standby pool until adopted by ephemeral_create.
/// Called after the main session registers; failures are logged but never
/// surfaced — the synchronous fallback path still works if warming fails.
fn warm_side_chat_standby(manager: Arc<PiManager>, cwd: PathBuf) {
    let Some(lease) = manager.begin_standby_warm(Some(&cwd), false) else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        let env = build_ephemeral_environment("side-chat", "standby", 0);
        match manager.spawn_standby(lease, cwd.clone(), false, None, env) {
            Ok(()) => log::info!("[pi-desktop] side-chat standby warmed"),
            Err(e) => log::warn!("[pi-desktop] side-chat standby warm failed: {}", e),
        }
    });
}

/// Pre-spawn a Quick Chat standby pi. Quick Chat uses a throwaway temp dir
/// as cwd (it has --no-tools, so the cwd is just an isolated scratch space).
/// We pre-create the temp dir, spawn the standby against it, and store the
/// dir alongside the standby so cleanup works after adoption. Warming a
/// Quick Chat standby is best-effort: if it fails, ephemeral_create falls
/// back to the synchronous spawn path.
fn warm_quick_chat_standby(manager: Arc<PiManager>) {
    let Some(lease) = manager.begin_standby_warm(None, true) else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        // Pre-create the temp dir here so the standby's cwd matches the dir
        // the caller would have created. If temp-dir creation fails we skip
        // warming; the synchronous fallback will create its own.
        let created = match create_quick_chat_temp_dir() {
            Ok(c) => c,
            Err(e) => {
                manager.cancel_standby_warm(&lease);
                log::warn!("[pi-desktop] quick-chat standby temp dir failed: {}", e);
                return;
            }
        };
        let cwd = created.0.clone();
        let env = build_ephemeral_environment("quick-chat", "standby", 0);
        match manager.spawn_standby(lease, cwd.clone(), true, Some(created), env) {
            Ok(()) => log::info!("[pi-desktop] quick-chat standby warmed"),
            Err(e) => log::warn!("[pi-desktop] quick-chat standby warm failed: {}", e),
        }
    });
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
        warm_model_cache(manager, port);
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
    if open_window {
        broker.register_session(port, session_path.unwrap_or(""));
        warm_model_cache(manager, port);
    } else {
        broker.track_background_session(port, session_path.unwrap_or(""));
    }
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
            open_workspace_window(app, port, cwd, &broker.url())?;
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

/// Maximum per-image file size accepted by the native picker (20 MB raw).
/// Images are read fully into memory and base64-encoded before being sent
/// over the control channel, so a cap prevents memory spikes on large photos.
const MAX_IMAGE_FILE_SIZE: u64 = 20 * 1024 * 1024;

/// Maximum number of images selectable in a single picker invocation.
const MAX_IMAGE_COUNT: usize = 10;

/// One selected image from the native multi-file picker. `data` is raw base64
/// of the file bytes (no `data:` prefix); the frontend image pipeline wraps it.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PickedImageFile {
    name: String,
    mime_type: String,
    data: String,
}

/// Map a file path's extension to a supported image MIME type. Case-insensitive.
/// Returns `None` for anything that is not a recognized image type.
fn image_mime_from_path(path: &std::path::Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// Native multi-file image picker. Opens a dialog filtered to image types,
/// optionally starting at `initial_dir`. Returns `Ok(None)` when the user
/// cancels. Each selected file is read and base64-encoded; unsupported or
/// unreadable selections are surfaced as an error rather than silently dropped.
/// Enforces a per-file size limit (`MAX_IMAGE_FILE_SIZE`) and a count limit
/// (`MAX_IMAGE_COUNT`) before reading any bytes.
async fn pick_image_files_core(
    app: &AppHandle,
    initial_dir: Option<String>,
) -> Result<Option<Vec<PickedImageFile>>, String> {
    use base64::Engine;

    let mut dialog = app
        .dialog()
        .file()
        .add_filter("Images", &["png", "jpg", "jpeg", "gif", "webp"]);

    if let Some(dir) = initial_dir.as_deref() {
        let p = std::path::Path::new(dir);
        if p.is_dir() {
            dialog = dialog.set_directory(p);
        }
    }

    let (tx, rx) = tokio::sync::oneshot::channel();
    dialog.pick_files(move |paths| {
        let _ = tx.send(paths);
    });
    let picked = rx.await.ok().flatten();

    let Some(paths) = picked else {
        return Ok(None);
    };

    if paths.len() > MAX_IMAGE_COUNT {
        return Err(format!(
            "Too many images selected: {}; maximum is {}",
            paths.len(),
            MAX_IMAGE_COUNT
        ));
    }

    let mut files = Vec::with_capacity(paths.len());
    for fp in paths {
        let pb = match fp {
            tauri_plugin_fs::FilePath::Path(pb) => pb,
            tauri_plugin_fs::FilePath::Url(url) => url
                .to_file_path()
                .map_err(|_| "Only local image files can be attached".to_string())?,
        };

        let mime = image_mime_from_path(&pb)
            .ok_or_else(|| format!("Unsupported image type: {}", pb.display()))?;

        let metadata = std::fs::metadata(&pb)
            .map_err(|e| format!("Failed to stat image {}: {}", pb.display(), e))?;
        if metadata.len() > MAX_IMAGE_FILE_SIZE {
            return Err(format!(
                "Image is too large: {} is {} MB; maximum is {} MB",
                pb.display(),
                metadata.len() / (1024 * 1024),
                MAX_IMAGE_FILE_SIZE / (1024 * 1024)
            ));
        }

        let bytes = std::fs::read(&pb)
            .map_err(|e| format!("Failed to read image {}: {}", pb.display(), e))?;

        let name = pb
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("image")
            .to_string();

        files.push(PickedImageFile {
            name,
            mime_type: mime.to_string(),
            data: base64::engine::general_purpose::STANDARD.encode(&bytes),
        });
    }

    Ok(Some(files))
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

fn open_workspace_window(
    app: &AppHandle,
    port: u16,
    cwd: &str,
    broker_ws_url: &str,
) -> Result<(), String> {
    let label = format!("workspace-{}", port);
    let url = format!(
        "http://localhost:{}?brokerWs={}",
        port,
        encode_query_value(broker_ws_url)
    );
    let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))
        .map_err(|e| format!("Failed to load window icon: {}", e))?;

    // Create the window owner before build so the capability and exact-origin
    // navigation boundary exist for the first document load. The owner binds
    // this window label, its canonical workspace cwd, and its primary Pi origin.
    let Some(registry) = app.try_state::<OwnerRegistryState>() else {
        return Err("owner registry is not available".to_string());
    };
    let registry = registry.inner().clone();
    let canonical_cwd = fs::canonicalize(cwd).unwrap_or_else(|_| PathBuf::from(cwd));
    let origin = format!("http://localhost:{port}");
    let (owner, capability) = registry
        .create_owner(label.clone(), canonical_cwd, port, origin)
        .map_err(|e| format!("Failed to create window owner: {e}"))?;
    let init_script =
        window_owner::capability_initialization_script("localhost", port, &capability);

    let nav_registry = registry.clone();
    let nav_owner = owner.clone();
    let builder =
        WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url.parse().unwrap()))
            .title("Picot")
            .inner_size(1300.0, 860.0)
            .min_inner_size(800.0, 600.0)
            .icon(icon)
            .map_err(|e| e.to_string())?
            .initialization_script(init_script)
            .on_navigation(move |url| nav_registry.authorize_navigation(&nav_owner, url))
            .on_new_window(|_url, _features| tauri::webview::NewWindowResponse::Deny);

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
    use super::{image_mime_from_path, resolve_static_dir, side_chat_startup_rpc_commands};
    use serde_json::json;
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

    #[test]
    fn image_mime_from_path_maps_known_extensions() {
        assert_eq!(
            image_mime_from_path(std::path::Path::new("photo.png")),
            Some("image/png")
        );
        assert_eq!(
            image_mime_from_path(std::path::Path::new("photo.JPG")),
            Some("image/jpeg")
        );
        assert_eq!(
            image_mime_from_path(std::path::Path::new("photo.Jpeg")),
            Some("image/jpeg")
        );
        assert_eq!(
            image_mime_from_path(std::path::Path::new("anim.gif")),
            Some("image/gif")
        );
        assert_eq!(
            image_mime_from_path(std::path::Path::new("modern.webp")),
            Some("image/webp")
        );
    }

    #[test]
    fn image_mime_from_path_rejects_unknown_and_missing_extensions() {
        assert_eq!(image_mime_from_path(std::path::Path::new("doc.pdf")), None);
        assert_eq!(image_mime_from_path(std::path::Path::new("img.bmp")), None);
        assert_eq!(image_mime_from_path(std::path::Path::new("noext")), None);
        assert_eq!(image_mime_from_path(std::path::Path::new("/")), None);
    }

    #[test]
    fn side_chat_startup_rpc_emits_set_model_and_thinking_for_active_profile() {
        let profile = json!({
            "provider": "openai-codex",
            "modelId": "gpt-5.6-terra",
            "thinkingLevel": "medium",
        });
        let cmds = side_chat_startup_rpc_commands(&profile);
        assert_eq!(cmds.len(), 2);
        assert_eq!(
            cmds[0],
            json!({"type":"set_model","provider":"openai-codex","modelId":"gpt-5.6-terra"})
        );
        assert_eq!(
            cmds[1],
            json!({"type":"set_thinking_level","level":"medium"})
        );
    }

    #[test]
    fn side_chat_startup_rpc_omits_thinking_when_off() {
        let profile = json!({
            "provider": "anthropic",
            "modelId": "claude-sonnet-4",
            "thinkingLevel": "off",
        });
        let cmds = side_chat_startup_rpc_commands(&profile);
        assert_eq!(cmds.len(), 1);
        assert_eq!(
            cmds[0],
            json!({"type":"set_model","provider":"anthropic","modelId":"claude-sonnet-4"})
        );
    }

    #[test]
    fn side_chat_startup_rpc_drops_profile_without_model_identity() {
        assert!(side_chat_startup_rpc_commands(&json!({"thinkingLevel":"medium"})).is_empty());
        assert!(side_chat_startup_rpc_commands(&json!({"provider":"","modelId":""})).is_empty());
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
    warm_model_cache(&manager, initial_port);
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
fn install_control_handler(
    broker: &Arc<BrokerWs>,
    manager: Arc<PiManager>,
    owner_registry: Arc<WindowOwnerRegistry>,
    ephemeral_registry: Arc<EphemeralRegistry>,
    app: AppHandle,
) {
    let broker_for_handler = broker.clone();
    let handler: broker_ws::ControlHandler = Arc::new(
        move |ctx: broker_ws::VerifiedClientContext,
              command: String,
              args: Value,
              progress: broker_ws::ProgressSink| {
            let manager = manager.clone();
            let broker = broker_for_handler.clone();
            let owner_registry = owner_registry.clone();
            let ephemeral_registry = ephemeral_registry.clone();
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
                        warm_side_chat_standby(manager.clone(), PathBuf::from(&cwd));
                        warm_quick_chat_standby(manager.clone());
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
                    "pick_image_files" => {
                        let initial_dir = arg_str("initialDir");
                        match pick_image_files_core(&app, initial_dir).await? {
                            Some(files) => Ok(serde_json::to_value(files).unwrap_or(Value::Null)),
                            None => Ok(Value::Null),
                        }
                    }
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
                    "get_cached_models" => Ok(manager
                        .cached_models()
                        .map(|c| c.payload)
                        .unwrap_or(Value::Null)),
                    "install_pi_package" => {
                        let source = arg_str("source").unwrap_or_default();
                        if source.trim().is_empty() {
                            return Err("Package source cannot be empty".to_string());
                        }
                        manager.install_package_source(source.trim())?;
                        manager.invalidate_cached_models();
                        Ok(Value::Null)
                    }
                    "remove_pi_package" => {
                        let source = arg_str("source").unwrap_or_default();
                        if source.trim().is_empty() {
                            return Err("Package source cannot be empty".to_string());
                        }
                        manager.remove_package_source(source.trim())?;
                        manager.invalidate_cached_models();
                        Ok(Value::Null)
                    }
                    "check_for_update" => check_for_update_core(&app).await,
                    "download_and_install_update" => {
                        download_and_install_update_core(&app, progress).await
                    }
                    "rpc_extension_ui_response" => {
                        let port = arg_u16("port").ok_or("port is required")?;
                        let response = arg("response");
                        if response.get("type").and_then(Value::as_str)
                            != Some("extension_ui_response")
                        {
                            return Err("invalid extension UI response".to_string());
                        }
                        manager.send_rpc(port, response)?;
                        Ok(Value::Null)
                    }
                    "ephemeral_extension_ui_response" => {
                        let Some(owner) = ctx.owner_id.clone() else {
                            return Err("ephemeral chats require a native owner".to_string());
                        };
                        let instance_id = arg_str("instanceId").ok_or("instanceId is required")?;
                        let generation =
                            arg("generation").as_u64().ok_or("generation is required")?;
                        let port = broker
                            .ephemeral_port(&owner, &instance_id, generation)
                            .ok_or("ephemeral instance is unavailable")?;
                        let response = arg("response");
                        if response.get("type").and_then(Value::as_str)
                            != Some("extension_ui_response")
                        {
                            return Err("invalid extension UI response".to_string());
                        }
                        manager.send_rpc(port, response)?;
                        Ok(Value::Null)
                    }
                    "ephemeral_create" => {
                        let Some(owner) = ctx.owner_id.clone() else {
                            return Err("ephemeral chats require a native owner".to_string());
                        };
                        let kind_str = arg_str("kind").unwrap_or_default();
                        let kind = match kind_str.as_str() {
                            "side-chat" => EphemeralKind::SideChat,
                            "quick-chat" => EphemeralKind::QuickChat,
                            _ => return Err("invalid ephemeral kind".to_string()),
                        };
                        if owner_registry.workspace_transition_in_progress(&owner) {
                            return Err("workspace transition is in progress".to_string());
                        }
                        let reservation = ephemeral_registry.reserve_create(&owner, kind)?;
                        let transition_generation = owner_registry
                            .current_workspace_generation(&owner)
                            .unwrap_or(0);
                        let (cwd, temp_dir) = match kind {
                            EphemeralKind::SideChat => {
                                let (ws_cwd, _) = owner_registry
                                    .current_workspace(&owner)
                                    .ok_or("owner has no workspace")?;
                                (ws_cwd, None)
                            }
                            EphemeralKind::QuickChat => {
                                let created = create_quick_chat_temp_dir()?;
                                let cwd = created.0.clone();
                                (cwd, Some(created))
                            }
                        };
                        let startup_profile = if kind == EphemeralKind::SideChat {
                            let profile = arg("startupProfile");
                            let provider = profile.get("provider").and_then(Value::as_str);
                            let model_id = profile.get("modelId").and_then(Value::as_str);
                            match (provider, model_id) {
                                (Some(provider), Some(model_id))
                                    if !provider.trim().is_empty()
                                        && !model_id.trim().is_empty() =>
                                {
                                    let thinking = profile
                                        .get("thinkingLevel")
                                        .and_then(Value::as_str)
                                        .unwrap_or("off");
                                    Some(serde_json::json!({
                                        "provider": provider.trim(),
                                        "modelId": model_id.trim(),
                                        "thinkingLevel": thinking,
                                    }))
                                }
                                _ => None,
                            }
                        } else {
                            None
                        };
                        let no_tools = kind == EphemeralKind::QuickChat;
                        // Try to adopt a pre-warmed standby pi first. The
                        // standby was spawned with the same cwd and no_tools
                        // flags but a placeholder ephemeral env; the broker
                        // route (registered below) maps its port to the real
                        // instance id, so the placeholder never leaks to the
                        // frontend. If no standby matches, fall back to a
                        // synchronous spawn + health-wait.
                        let standby = manager.take_standby(&cwd, no_tools);
                        let cwd_for_refill = cwd.clone();
                        let descriptor = if let Some((spawned, standby_temp_dir)) = standby {
                            log::info!(
                                "[pi-desktop] adopting standby pi: port={} kind={}",
                                spawned.port,
                                kind_str
                            );
                            // Use the standby's pre-created temp dir for Quick
                            // Chat; for Side Chat the temp_dir from the caller
                            // is None and the standby also carries None. If
                            // the standby carries its own temp dir (Quick Chat
                            // standby), clean up the one the caller created to
                            // avoid leaking it.
                            let adopted_temp_dir = if standby_temp_dir.is_some() {
                                if let Some((path, token)) = &temp_dir {
                                    let _ =
                                        cleanup_quick_chat_dir(&canonical_temp_root(), path, token);
                                }
                                standby_temp_dir
                            } else {
                                temp_dir
                            };
                            // The standby's cwd is what pi actually runs in.
                            // Override the caller's cwd so the registry records
                            // the real one.
                            let adopted_cwd = if adopted_temp_dir.is_some() {
                                adopted_temp_dir
                                    .as_ref()
                                    .map(|(p, _)| p.clone())
                                    .unwrap_or(cwd.clone())
                            } else {
                                cwd.clone()
                            };
                            ephemeral_adopt_standby(
                                &manager,
                                &broker,
                                &ephemeral_registry,
                                &reservation,
                                spawned,
                                adopted_temp_dir,
                                transition_generation,
                                adopted_cwd.clone(),
                                startup_profile,
                            )
                            .await?
                        } else {
                            let port = manager.next_port();
                            let env = build_ephemeral_environment(
                                &kind_str,
                                &reservation.instance_id,
                                reservation.generation,
                            );
                            let spec = PiSpawnSpec {
                                cwd,
                                port,
                                session_path: None,
                                no_session: true,
                                no_tools,
                                environment: env,
                            };
                            ephemeral_spawn_commit(
                                &manager,
                                &broker,
                                &ephemeral_registry,
                                &reservation,
                                spec,
                                port,
                                temp_dir,
                                transition_generation,
                                startup_profile,
                            )
                            .await?
                        };
                        // Refill the standby pool after consumption so the
                        // next Side/Quick Chat is also instant.
                        if kind == EphemeralKind::SideChat {
                            warm_side_chat_standby(manager.clone(), cwd_for_refill);
                        } else {
                            warm_quick_chat_standby(manager.clone());
                        }
                        Ok(serde_json::to_value(descriptor).map_err(|e| e.to_string())?)
                    }
                    "ephemeral_replace_quick" => {
                        let Some(owner) = ctx.owner_id.clone() else {
                            return Err("ephemeral chats require a native owner".to_string());
                        };
                        if owner_registry.workspace_transition_in_progress(&owner) {
                            return Err("workspace transition is in progress".to_string());
                        }
                        let replacement = ephemeral_registry.reserve_quick_replacement(&owner)?;
                        let (old_id, old_gen) = replacement
                            .old_instance
                            .clone()
                            .ok_or("no quick chat to replace")?;
                        let candidate = replacement.candidate.clone();
                        let created = create_quick_chat_temp_dir()?;
                        let cwd = created.0.clone();
                        let port = manager.next_port();
                        let env = build_ephemeral_environment(
                            "quick-chat",
                            &candidate.instance_id,
                            candidate.generation,
                        );
                        let spec = PiSpawnSpec {
                            cwd,
                            port,
                            session_path: None,
                            no_session: true,
                            no_tools: true,
                            environment: env,
                        };
                        let transition_generation = owner_registry
                            .current_workspace_generation(&owner)
                            .unwrap_or(0);
                        let descriptor = ephemeral_spawn_commit(
                            &manager,
                            &broker,
                            &ephemeral_registry,
                            &candidate,
                            spec,
                            port,
                            Some(created),
                            transition_generation,
                            None,
                        )
                        .await?;
                        close_ephemeral_instance(
                            &manager,
                            &broker,
                            &ephemeral_registry,
                            &owner,
                            &old_id,
                            old_gen,
                        );
                        Ok(serde_json::to_value(descriptor).map_err(|e| e.to_string())?)
                    }
                    "ephemeral_close" => {
                        let Some(owner) = ctx.owner_id.clone() else {
                            return Err("ephemeral chats require a native owner".to_string());
                        };
                        let instance_id = arg_str("instanceId").ok_or("instanceId is required")?;
                        let generation =
                            arg("generation").as_u64().ok_or("generation is required")?;
                        close_ephemeral_instance(
                            &manager,
                            &broker,
                            &ephemeral_registry,
                            &owner,
                            &instance_id,
                            generation,
                        );
                        Ok(Value::Null)
                    }
                    "ephemeral_bootstrap" => {
                        let Some(owner) = ctx.owner_id.clone() else {
                            return Err("ephemeral chats require a native owner".to_string());
                        };
                        Ok(serde_json::to_value(ephemeral_registry.descriptors(&owner))
                            .map_err(|e| e.to_string())?)
                    }
                    "ephemeral_update_ui" => {
                        let Some(owner) = ctx.owner_id.clone() else {
                            return Err("ephemeral chats require a native owner".to_string());
                        };
                        let instance_id = arg_str("instanceId").ok_or("instanceId is required")?;
                        let generation =
                            arg("generation").as_u64().ok_or("generation is required")?;
                        let patch = EphemeralUiPatch {
                            title: arg_str("title"),
                            unread: arg_bool("unread"),
                        };
                        ephemeral_registry.update_ui_metadata(
                            &owner,
                            &instance_id,
                            generation,
                            patch,
                        )?;
                        Ok(Value::Null)
                    }
                    "workspace_target_prepare" => {
                        let Some(owner) = ctx.owner_id.clone() else {
                            return Err("workspace navigation requires a native owner".to_string());
                        };
                        let target_cwd = arg_str("targetCwd").ok_or("targetCwd is required")?;
                        let canonical_target = fs::canonicalize(&target_cwd)
                            .map_err(|e| format!("Invalid targetCwd: {e}"))?;
                        let session_path = arg_str("sessionPath");
                        let force_new = arg_bool("forceNewSession").unwrap_or(false);
                        let (current_cwd, _) = owner_registry
                            .current_workspace(&owner)
                            .ok_or("owner has no workspace")?;
                        let target_port = if let Some(existing_port) = arg_u16("targetPort") {
                            if !manager.owns_process(existing_port) {
                                return Err("target process is not owned by Picot".to_string());
                            }
                            if let Some(status) = manager.check_exited(existing_port) {
                                return Err(format!(
                                    "Target Pi process exited (port {existing_port}, status: {status})"
                                ));
                            }
                            wait_for_pi_health(existing_port, 30).await?;
                            existing_port
                        } else {
                            spawn_target_process(
                                &canonical_target.to_string_lossy(),
                                session_path.as_deref(),
                                force_new,
                                &manager,
                                &broker,
                            )
                            .await?
                        };
                        let target_origin = format!("http://localhost:{target_port}");
                        let same_cwd = canonical_target == current_cwd;
                        let transition_generation = if same_cwd {
                            owner_registry.prepare_navigation(
                                &owner,
                                target_port,
                                canonical_target.clone(),
                                target_origin.clone(),
                                std::time::Duration::from_secs(30),
                            )?
                        } else {
                            let gen = owner_registry.begin_workspace_transition(
                                &owner,
                                canonical_target.clone(),
                                target_port,
                            )?;
                            owner_registry.prepare_navigation(
                                &owner,
                                target_port,
                                canonical_target.clone(),
                                target_origin.clone(),
                                std::time::Duration::from_secs(30),
                            )?;
                            gen
                        };
                        Ok(serde_json::json!({
                            "classification": if same_cwd { "same" } else { "cross" },
                            "transitionGeneration": transition_generation,
                            "targetOrigin": target_origin,
                            "settleRequired": !same_cwd,
                        }))
                    }
                    "workspace_transition_commit" => {
                        let Some(owner) = ctx.owner_id.clone() else {
                            return Err("workspace navigation requires a native owner".to_string());
                        };
                        let gen = arg("transitionGeneration")
                            .as_u64()
                            .ok_or("transitionGeneration is required")?;
                        // Safety net: generation-checked cleanup of any old-workspace
                        // side chats the frontend did not settle before committing.
                        let is_cross_workspace = owner_registry
                            .current_workspace(&owner)
                            .zip(owner_registry.pending_target_cwd(&owner))
                            .is_none_or(|((current_cwd, _), target_cwd)| current_cwd != target_cwd);
                        if is_cross_workspace {
                            let stray =
                                ephemeral_registry.side_chat_cleanup_for_transition(&owner, gen);
                            for lease in stray {
                                cleanup_ephemeral_lease(
                                    &manager,
                                    &broker,
                                    &ephemeral_registry,
                                    lease,
                                );
                            }
                        }
                        // Also discard any Side Chat standby pre-warmed for
                        // the old workspace cwd — they'd never be adopted now.
                        if let Some((old_cwd, _)) = owner_registry.current_workspace(&owner) {
                            manager.kill_standby_for_cwd(&old_cwd);
                        }
                        // Pre-warm a Side Chat standby for the new workspace
                        // so the first Side Chat after the transition is instant.
                        if let Some(target_cwd) = owner_registry.pending_target_cwd(&owner) {
                            warm_side_chat_standby(manager.clone(), target_cwd);
                        }
                        let target_origin = owner_registry
                            .pending_target_origin(&owner)
                            .ok_or("no pending workspace transition")?;
                        let target_port = owner_registry
                            .pending_target_port(&owner)
                            .ok_or("no pending workspace transition")?;
                        owner_registry.commit_workspace_transition(
                            &owner,
                            gen,
                            target_origin.clone(),
                        )?;
                        broker.set_active_port(target_port);
                        Ok(serde_json::json!({ "targetOrigin": target_origin }))
                    }
                    "workspace_transition_cancel" => {
                        let Some(owner) = ctx.owner_id.clone() else {
                            return Err("workspace navigation requires a native owner".to_string());
                        };
                        let gen = arg("transitionGeneration")
                            .as_u64()
                            .ok_or("transitionGeneration is required")?;
                        if let Some(target_port) = owner_registry.pending_target_port(&owner) {
                            manager.kill(target_port);
                            broker.unregister_port(target_port);
                        }
                        owner_registry.cancel_workspace_transition(&owner, gen)?;
                        Ok(Value::Null)
                    }
                    "window_close_cancel" => {
                        let Some(owner) = ctx.owner_id.clone() else {
                            return Err("window close requires a native owner".to_string());
                        };
                        let request_id = arg_str("requestId").ok_or("requestId is required")?;
                        let mut guard = close_approvals().lock().unwrap();
                        if guard
                            .get(&owner)
                            .is_some_and(|pending| pending.request_id == request_id)
                        {
                            guard.remove(&owner);
                        }
                        Ok(Value::Null)
                    }
                    "window_close_approve" => {
                        let Some(owner) = ctx.owner_id.clone() else {
                            return Err("window close requires a native owner".to_string());
                        };
                        let request_id = arg_str("requestId").ok_or("requestId is required")?;
                        {
                            let mut guard = close_approvals().lock().unwrap();
                            let Some(pending) = guard.get_mut(&owner) else {
                                return Err("no pending window close".to_string());
                            };
                            if pending.request_id != request_id {
                                return Err("request id mismatch".to_string());
                            }
                            pending.approved = true;
                        }
                        if let Some(label) = owner_registry.label_for_owner(&owner) {
                            if let Some(win) = app.get_webview_window(&label) {
                                let _ = win.close();
                            }
                        }
                        Ok(Value::Null)
                    }
                    "window_close_risk_response" => {
                        // The frontend close coordinator owns the risk dialog and
                        // per-participant settlement; the host only acts on the
                        // final window_close_approve, so this is acknowledged.
                        Ok(Value::Null)
                    }
                    "relaunch_app" => app.restart(),
                    other => Err(format!("Unknown control command: {other}")),
                }
            })
        },
    );
    broker.set_control_handler(handler);
}

/// Spawn a workspace Pi process for an in-window navigation WITHOUT promoting
/// it to the broker active_port; the target only becomes the main session once
/// the workspace transition commits. Mirrors open_workspace_core's spawn +
/// readiness checks but registers the upstream as a background session.
async fn spawn_target_process(
    cwd: &str,
    session_path: Option<&str>,
    force_new_session: bool,
    manager: &PiManager,
    broker: &BrokerWs,
) -> Result<u16, String> {
    let port = manager.next_port();
    manager.spawn(cwd, port, session_path)?;
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    if let Some(status) = manager.check_exited(port) {
        return Err(format!(
            "Pi process exited immediately (port {port}, status: {status})"
        ));
    }
    wait_for_pi_health(port, 30).await?;
    if force_new_session {
        manager.send_rpc(port, serde_json::json!({ "type": "new_session" }))?;
    }
    broker.track_background_session(port, session_path.unwrap_or(""));
    Ok(port)
}

/// Spawn an ephemeral candidate, wait for readiness, and compare-and-commit it.
/// On any failure the candidate process, broker route, registry record, and
/// (for Quick Chat) temp directory are cleaned up before returning the error.
#[allow(clippy::too_many_arguments)]
async fn ephemeral_spawn_commit(
    manager: &PiManager,
    broker: &BrokerWs,
    registry: &EphemeralRegistry,
    reservation: &CreateReservation,
    spec: PiSpawnSpec,
    port: u16,
    temp_dir: Option<(PathBuf, String)>,
    transition_generation: u64,
    startup_profile: Option<Value>,
) -> Result<ephemeral_registry::EphemeralDescriptor, String> {
    let owner = reservation.owner_id.clone();
    let spawned = match manager.spawn_with_spec(&spec) {
        Ok(spawned) => spawned,
        Err(e) => {
            cleanup_ephemeral_candidate(
                registry,
                &owner,
                &reservation.instance_id,
                reservation.generation,
                temp_dir,
            );
            return Err(e);
        }
    };
    if let Err(e) = wait_for_pi_health(port, 30).await {
        manager.kill(port);
        cleanup_ephemeral_candidate(
            registry,
            &owner,
            &reservation.instance_id,
            reservation.generation,
            temp_dir,
        );
        return Err(e);
    }
    let process = OwnedProcess {
        port,
        pid: spawned.pid,
        child_identity: spawned.identity,
        canonical_cwd: spec.cwd.clone(),
        transition_generation,
        temporary_directory: temp_dir.clone(),
    };
    let descriptor = match registry.commit_ready(reservation, process) {
        Ok(descriptor) => descriptor,
        Err(e) => {
            manager.kill(port);
            cleanup_ephemeral_candidate(
                registry,
                &owner,
                &reservation.instance_id,
                reservation.generation,
                temp_dir,
            );
            return Err(e);
        }
    };
    let _ = broker.register_ephemeral_route(broker_ws::EphemeralRoute {
        owner_id: owner,
        instance_id: reservation.instance_id.clone(),
        generation: reservation.generation,
        port,
    });
    // Defer set_model until after the frontend's initial runtime snapshot
    // has been processed. The snapshot — fired when the descriptor arrives
    // — reads Pi's advisor-restored model. Sending set_model before the
    // snapshot returns means the Side Chat initially shows Pi's default
    // model, not the inherited one. The 400ms delay lets the snapshot
    // settle first; the set_model then sticks and a later state refresh
    // picks up the new model.
    apply_side_chat_startup_profile(manager, port, startup_profile);
    Ok(descriptor)
}

/// Adopt a pre-warmed standby pi for an ephemeral chat. The standby is
/// already spawned and healthy; we only register it with the broker and
/// registry, then apply the startup profile. This is the fast path
/// (~milliseconds) compared to spawn + health-wait (~seconds).
#[allow(clippy::too_many_arguments)]
async fn ephemeral_adopt_standby(
    manager: &PiManager,
    broker: &BrokerWs,
    registry: &EphemeralRegistry,
    reservation: &CreateReservation,
    spawned: pi_manager::SpawnedPi,
    temp_dir: Option<(PathBuf, String)>,
    transition_generation: u64,
    cwd: PathBuf,
    startup_profile: Option<Value>,
) -> Result<ephemeral_registry::EphemeralDescriptor, String> {
    let owner = reservation.owner_id.clone();
    let port = spawned.port;
    let process = OwnedProcess {
        port,
        pid: spawned.pid,
        child_identity: spawned.identity,
        canonical_cwd: cwd,
        transition_generation,
        temporary_directory: temp_dir.clone(),
    };
    let descriptor = match registry.commit_ready(reservation, process) {
        Ok(descriptor) => descriptor,
        Err(e) => {
            manager.kill(port);
            cleanup_ephemeral_candidate(
                registry,
                &owner,
                &reservation.instance_id,
                reservation.generation,
                temp_dir,
            );
            return Err(e);
        }
    };
    let _ = broker.register_ephemeral_route(broker_ws::EphemeralRoute {
        owner_id: owner,
        instance_id: reservation.instance_id.clone(),
        generation: reservation.generation,
        port,
    });
    apply_side_chat_startup_profile(manager, port, startup_profile);
    Ok(descriptor)
}

/// Build the RPC commands that mirror the active workspace session's model
/// and thinking level into a freshly spawned Side Chat. Returns None when the
/// profile is missing or incomplete so the caller can skip the round-trip.
fn side_chat_startup_rpc_commands(profile: &Value) -> Vec<Value> {
    let mut commands = Vec::new();
    let provider = profile.get("provider").and_then(Value::as_str);
    let model_id = profile.get("modelId").and_then(Value::as_str);
    let thinking = profile.get("thinkingLevel").and_then(Value::as_str);
    if let (Some(provider), Some(model_id)) = (provider, model_id) {
        if !provider.is_empty() && !model_id.is_empty() {
            commands.push(serde_json::json!({
                "type": "set_model",
                "provider": provider,
                "modelId": model_id,
            }));
            if let Some(level) = thinking {
                if !level.is_empty() && level != "off" {
                    commands.push(serde_json::json!({
                        "type": "set_thinking_level",
                        "level": level,
                    }));
                }
            }
        }
    }
    commands
}

fn apply_side_chat_startup_profile(manager: &PiManager, port: u16, startup_profile: Option<Value>) {
    let Some(profile) = startup_profile else {
        return;
    };
    let commands = side_chat_startup_rpc_commands(&profile);
    if commands.is_empty() {
        log::info!(
            "[pi-desktop] side-chat startup profile incomplete; skipping model RPC (port={})",
            port
        );
        return;
    }
    let model = commands
        .iter()
        .find(|c| c.get("type").and_then(Value::as_str) == Some("set_model"))
        .and_then(|c| c.get("modelId").and_then(Value::as_str))
        .unwrap_or("");
    log::info!(
        "[pi-desktop] applying side-chat startup profile: port={} model={}",
        port,
        model
    );
    for cmd in commands {
        if let Err(e) = manager.send_rpc(port, cmd) {
            log::warn!("[pi-desktop] side-chat startup rpc failed: {}", e);
        }
    }
}

/// Remove an uncommitted/failed candidate: generation-checked registry cleanup
/// plus exact Quick Chat temp directory deletion. Never touches another record.
fn cleanup_ephemeral_candidate(
    registry: &EphemeralRegistry,
    owner: &window_owner::OwnerId,
    instance_id: &str,
    generation: u64,
    temp_dir: Option<(PathBuf, String)>,
) {
    if let Ok(Some(lease)) = registry.begin_close(owner, instance_id, generation) {
        registry.finish_cleanup(&lease);
    }
    if let Some((path, token)) = temp_dir {
        let _ = cleanup_quick_chat_dir(&canonical_temp_root(), &path, &token);
    }
}

/// Generation-checked close of a live ephemeral instance: mark closing, kill the
/// exact (port, pid), unregister the route, delete an owned temp directory, and
/// remove the record only when identity still matches.
fn close_ephemeral_instance(
    manager: &PiManager,
    broker: &BrokerWs,
    registry: &EphemeralRegistry,
    owner: &window_owner::OwnerId,
    instance_id: &str,
    generation: u64,
) {
    let Ok(Some(lease)) = registry.begin_close(owner, instance_id, generation) else {
        return;
    };
    cleanup_ephemeral_lease(manager, broker, registry, lease);
}

fn cleanup_ephemeral_lease(
    manager: &PiManager,
    broker: &BrokerWs,
    registry: &EphemeralRegistry,
    lease: CleanupLease,
) {
    // Stop the broker's reconnect loop before killing the child. Otherwise its
    // next connect attempt races the intentional port shutdown and logs a
    // spurious connection-refused warning.
    broker.unregister_ephemeral_route(
        &lease.owner_id,
        &lease.instance_id,
        lease.generation,
        lease.port,
    );
    if lease.port != 0
        && manager.matches_process_identity(lease.port, lease.pid, lease.child_identity)
    {
        manager.kill(lease.port);
    }
    if let Some((path, token)) = &lease.temporary_directory {
        let _ = cleanup_quick_chat_dir(&canonical_temp_root(), path, token);
    }
    registry.finish_cleanup(&lease);
}

/// A pending window-close transaction: the request id issued to the frontend
/// coordinator and whether its final approval has been received.
#[derive(Clone)]
struct PendingClose {
    request_id: String,
    approved: bool,
}

static CLOSE_REQUEST_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn close_approvals(
) -> &'static std::sync::Mutex<std::collections::HashMap<window_owner::OwnerId, PendingClose>> {
    static CLOSE_APPROVALS: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<window_owner::OwnerId, PendingClose>>,
    > = std::sync::OnceLock::new();
    CLOSE_APPROVALS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Intercept the native close. The first request is prevented and one
/// owner-targeted close_request is issued; a matching window_close_approve sets
/// the one-shot approval consumed by the close triggered from the host. A
/// disconnected WebView falls back to a native warning.
fn handle_close_requested(window: &tauri::Window, api: &tauri::CloseRequestApi) {
    let Some(registry) = window.try_state::<OwnerRegistryState>() else {
        return;
    };
    let registry = registry.inner().clone();
    let Some(owner) = registry.owner_for_label(window.label()) else {
        return;
    };

    let approvals = close_approvals();
    let mut guard = approvals.lock().unwrap();
    if let Some(pending) = guard.get(&owner) {
        if pending.approved {
            // Consumed: allow this close.
            guard.remove(&owner);
            return;
        }
        // Still pending: prevent and let the existing dialog keep focus.
        api.prevent_close();
        return;
    }
    api.prevent_close();
    let request_id = format!(
        "close-{}",
        CLOSE_REQUEST_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    guard.insert(
        owner.clone(),
        PendingClose {
            request_id: request_id.clone(),
            approved: false,
        },
    );
    drop(guard);

    let delivered = window
        .try_state::<BrokerWsState>()
        .map(|broker| {
            broker.send_owner_event(
                &owner,
                serde_json::json!({ "type": "window_close_request", "requestId": request_id }),
            )
        })
        .unwrap_or(false);
    if delivered {
        return;
    }

    // Disconnected WebView fallback: a native warning. Confirm closes (after
    // settlement of host-owned state); cancel drops the pending request.
    let app = window.app_handle().clone();
    let owner_for_dialog = owner.clone();
    let registry_for_dialog = registry.clone();
    window
        .app_handle()
        .dialog()
        .message("Closing this window will discard unsaved changes and any temporary chats.")
        .title("Close window")
        .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(
            "Close anyway".to_string(),
            "Cancel".to_string(),
        ))
        .show(move |result| {
            let mut g = close_approvals().lock().unwrap();
            if result {
                if let Some(pending) = g.get_mut(&owner_for_dialog) {
                    pending.approved = true;
                }
                let label = registry_for_dialog.label_for_owner(&owner_for_dialog);
                drop(g);
                if let Some(label) = label {
                    let _ = app.get_webview_window(&label).map(|w| w.close());
                }
            } else {
                g.remove(&owner_for_dialog);
            }
        });
}

/// Final idempotent cleanup when a workspace window is destroyed: kill the
/// workspace process, unregister its broker routes, run generation-checked
/// ephemeral cleanup, drop any pending close, and revoke the owner.
fn handle_window_destroyed(window: &tauri::Window) {
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

    let Some(registry) = window.try_state::<OwnerRegistryState>() else {
        return;
    };
    let registry = registry.inner().clone();
    let Some(owner) = registry.owner_for_label(label) else {
        return;
    };
    if let Some(manager) = window.try_state::<PiManagerState>() {
        if let Some((cwd, _)) = registry.current_workspace(&owner) {
            manager.kill_standby_for_cwd(&cwd);
        }
        manager.kill_quick_standby();
    }
    if let Some(ephemeral) = window.try_state::<EphemeralRegistryState>() {
        for lease in ephemeral.owner_cleanup(&owner) {
            if let Some(broker) = window.try_state::<BrokerWsState>() {
                broker.unregister_ephemeral_route(
                    &owner,
                    &lease.instance_id,
                    lease.generation,
                    lease.port,
                );
            }
            if lease.port != 0 {
                if let Some(manager) = window.try_state::<PiManagerState>() {
                    if manager.matches_process_identity(lease.port, lease.pid, lease.child_identity)
                    {
                        manager.kill(lease.port);
                    }
                }
            }
            if let Some((path, token)) = &lease.temporary_directory {
                let _ = cleanup_quick_chat_dir(&canonical_temp_root(), path, token);
            }
            ephemeral.finish_cleanup(&lease);
        }
    }
    close_approvals().lock().unwrap().remove(&owner);
    registry.revoke_owner(&owner);
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
            let owner_registry = Arc::new(WindowOwnerRegistry::default());
            let ephemeral_registry = Arc::new(EphemeralRegistry::default());
            broker.set_owner_registry(owner_registry.clone());
            let descriptor_registry = ephemeral_registry.clone();
            broker.set_ephemeral_descriptor_provider(Arc::new(move |owner| {
                serde_json::to_value(descriptor_registry.descriptors(owner))
                    .unwrap_or_else(|_| Value::Array(Vec::new()))
            }));
            std::env::set_var("PI_STUDIO_BROKER_PORT", broker.port().to_string());
            install_control_handler(
                &broker,
                manager.clone(),
                owner_registry.clone(),
                ephemeral_registry.clone(),
                app.handle().clone(),
            );

            let manager_for_rpc_output = manager.clone();
            let mut rpc_output_rx = manager.subscribe_rpc_outputs();
            let broker_for_rpc_output = broker.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    match rpc_output_rx.recv().await {
                        Ok(output) => {
                            // Forward extension UI requests to the broker.
                            broker_for_rpc_output
                                .publish_rpc_output(output.port, output.payload.clone());
                            // Diagnostic: log set_model / set_thinking_level
                            // responses so we can see whether Side Chat's
                            // startup profile RPCs reach Pi and succeed.
                            let cmd = output
                                .payload
                                .get("command")
                                .and_then(Value::as_str)
                                .unwrap_or("");
                            if cmd == "set_model" || cmd == "set_thinking_level" {
                                let success = output
                                    .payload
                                    .get("success")
                                    .and_then(Value::as_bool)
                                    .unwrap_or(false);
                                let model_id = output
                                    .payload
                                    .pointer("/data/model/id")
                                    .and_then(Value::as_str)
                                    .unwrap_or("");
                                log::info!(
                                    "[pi-desktop] rpc response port={} cmd={} success={} model={}",
                                    output.port,
                                    cmd,
                                    success,
                                    model_id
                                );
                            }
                            // Capture get_available_models responses to populate
                            // the shared model cache. The cache lets Side Chat,
                            // Quick Chat, and new sessions render dropdowns
                            // instantly without each re-querying Pi.
                            if let Some(models) = output.payload.get("data").and_then(|d| d.get("models")) {
                                if output
                                    .payload
                                    .get("command")
                                    .and_then(Value::as_str)
                                    == Some("get_available_models")
                                {
                                    manager_for_rpc_output.store_cached_models(
                                        output.port,
                                        serde_json::json!({ "models": models.clone() }),
                                    );
                                }
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            });

            let mut exit_rx = manager.subscribe_exits();
            let manager_for_exit = manager.clone();
            let broker_for_exit = broker.clone();
            let ephemeral_for_exit = ephemeral_registry.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    match exit_rx.recv().await {
                        Ok(exit) => {
                            if let Some(lease) = ephemeral_for_exit
                                .process_exit_cleanup(exit.port, exit.pid, exit.identity)
                            {
                                cleanup_ephemeral_lease(
                                    &manager_for_exit,
                                    &broker_for_exit,
                                    &ephemeral_for_exit,
                                    lease,
                                );
                            } else if !manager_for_exit.cleanup_exited_standby(exit) {
                                broker_for_exit.unregister_port(exit.port);
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            });

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
            app.manage(owner_registry.clone());
            app.manage(ephemeral_registry.clone());

            if startup_ok {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = wait_for_pi_health(initial_port, 30).await {
                        log::error!("Pi failed to start: {}", e);
                    } else if let Some(broker) = app_handle.try_state::<BrokerWsState>() {
                        // Register only after the embedded server owns the port;
                        // otherwise BrokerWs logs expected connection-refused
                        // retries during every normal startup.
                        broker.register_session(
                            initial_port,
                            session_path.as_deref().unwrap_or(""),
                        );
                        if let Some(manager) = app_handle.try_state::<PiManagerState>() {
                            warm_model_cache(&manager, initial_port);
                            warm_quick_chat_standby(manager.inner().clone());
                            warm_side_chat_standby(manager.inner().clone(), PathBuf::from(&cwd));
                        }
                        if let Err(e) =
                            open_workspace_window(&app_handle, initial_port, &cwd, &broker.url())
                        {
                            log::error!("Failed to open window: {}", e);
                        }
                    } else {
                        log::error!("Failed to open window: broker websocket state missing");
                    }
                });
            }

            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                handle_close_requested(window, api);
            }
            tauri::WindowEvent::Destroyed => {
                handle_window_destroyed(window);
            }
            _ => {}
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
                    manager.kill_all_standby();
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
