#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod host_data;
mod host_router;
mod host_server;
mod metadata_store;
mod native_pi_manager;
mod pi_launch;
mod pi_rpc_bridge;
mod remote_auth;
mod runtime_coordinator;
mod settings_store;

use host_server::HostServer;
use metadata_store::MetadataStore;
use native_pi_manager::NativePiManager;
use pi_launch::PiLaunchResolver;
use remote_auth::RemoteAuth;
use runtime_coordinator::RuntimeTarget;
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, TitleBarStyle, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_dialog::MessageDialogKind;
use tauri_plugin_updater::UpdaterExt;

type NativePiManagerState = NativePiManager;

const MENU_NEW_SESSION_ID: &str = "picot-new-session";
const BETA_UPDATE_ENDPOINT: &str =
    "https://github.com/shixin-guo/picot/releases/download/beta/latest.json";

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BetaUpdateInfo {
    version: String,
    date: Option<String>,
    body: Option<String>,
}

fn beta_updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    let endpoint = reqwest::Url::parse(BETA_UPDATE_ENDPOINT)
        .map_err(|error| format!("Invalid beta updater endpoint: {error}"))?;
    app.updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|error| format!("Invalid beta updater configuration: {error}"))?
        .build()
        .map_err(|error| format!("Failed to initialize beta updater: {error}"))
}

#[tauri::command]
async fn check_beta_update(app: AppHandle) -> Result<Option<BetaUpdateInfo>, String> {
    let updater = beta_updater(&app)?;
    let update = updater
        .check()
        .await
        .map_err(|error| format!("Beta update check failed: {error}"))?;
    Ok(update.map(|update| BetaUpdateInfo {
        version: update.version,
        date: update.date.map(|date| date.to_string()),
        body: update.body,
    }))
}

#[tauri::command]
async fn install_beta_update(app: AppHandle) -> Result<(), String> {
    let updater = beta_updater(&app)?;
    let update = updater
        .check()
        .await
        .map_err(|error| format!("Beta update check failed: {error}"))?
        .ok_or_else(|| "No beta update is available".to_string())?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|error| format!("Beta update installation failed: {error}"))
}

/// Shared services needed to bring up an additional workspace window after
/// startup (when the user opens a folder as a new workspace).
struct WorkspaceLauncher {
    metadata: Arc<Mutex<MetadataStore>>,
    launch: PiLaunchResolver,
}

struct FocusedWorkspaceState(Mutex<Option<String>>);
struct WindowWorkspaceState(Mutex<HashMap<String, String>>);

/// Open the native folder picker and, if the user selects a directory, switch
/// the focused Picot window to that workspace. Returns the chosen path, or
/// `None` if cancelled.
#[tauri::command]
async fn open_folder_as_workspace(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Option<String>, String> {
    let Some(picked) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let path = picked
        .as_path()
        .ok_or_else(|| "Selected folder is not a local path".to_string())?
        .to_path_buf();
    open_workspace_at_path(&app, Some(&window), &path, None)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Open a brand-new session in the given workspace (identified by its
/// file-system path). If the workspace window is already open, spawn a fresh
/// runtime and navigate that window to the new temporary session; otherwise
/// open a new workspace window at the fresh session.
#[tauri::command]
async fn open_new_session_in_workspace(
    app: AppHandle,
    window: WebviewWindow,
    project_path: String,
) -> Result<(), String> {
    let cwd = PathBuf::from(&project_path);
    if !cwd.is_dir() {
        return Err(format!("Project folder no longer exists: {project_path}"));
    }
    open_fresh_session_at_path(&app, Some(&window), &cwd)
}

/// Switch the focused Picot window to `projectPath` and resume the given saved
/// session in it. Used by the sidebar to jump to a session that belongs to a
/// different project without opening a second project window.
#[tauri::command]
async fn open_session_in_project(
    app: AppHandle,
    window: WebviewWindow,
    project_path: String,
    session_id: String,
) -> Result<(), String> {
    let cwd = PathBuf::from(&project_path);
    if !cwd.is_dir() {
        return Err(format!("Project folder no longer exists: {project_path}"));
    }
    let session = session_id.trim();
    let resume = if session.is_empty() {
        None
    } else {
        Some(session.to_string())
    };
    open_workspace_at_path(&app, Some(&window), &cwd, resume.as_deref())
}

fn spawn_fresh_runtime(
    runtimes: &NativePiManagerState,
    launch: &PiLaunchResolver,
    cwd: &Path,
    workspace_id: String,
) -> Result<RuntimeTarget, String> {
    let session_id = format!("temporary-{}", uuid::Uuid::new_v4().simple());
    let instance_id = format!("instance-{}", uuid::Uuid::new_v4().simple());
    let target = RuntimeTarget::new(workspace_id, session_id, instance_id);
    let cwd_str = cwd.to_string_lossy().into_owned();
    let launch_spec = launch.native_launch_spec(&cwd_str, None)?;
    runtimes.spawn(target.clone(), launch_spec)?;
    Ok(target)
}

fn open_fresh_session_at_path(
    app: &AppHandle,
    source_window: Option<&WebviewWindow>,
    cwd: &Path,
) -> Result<(), String> {
    let launcher = app
        .try_state::<WorkspaceLauncher>()
        .ok_or_else(|| "Workspace launcher is not ready".to_string())?;
    let host = app
        .try_state::<HostServer>()
        .ok_or_else(|| "Host server is not ready".to_string())?;
    let runtimes = app
        .try_state::<NativePiManagerState>()
        .ok_or_else(|| "Native runtime manager is not ready".to_string())?;
    let workspace_id = launcher
        .metadata
        .lock()
        .map_err(|_| "Picot metadata store is unavailable".to_string())?
        .workspace_id_for_path(cwd)?;

    host.register_workspace(&workspace_id, cwd.to_path_buf())?;
    let target = spawn_fresh_runtime(&runtimes, &launcher.launch, cwd, workspace_id.clone())?;
    if let Some(window) =
        source_window.filter(|window| window.label().starts_with("native-workspace-"))
    {
        return navigate_workspace_window(app, window, host.origin(), &target, true);
    }
    let label = format!("native-workspace-{workspace_id}");
    if let Some(existing) = app.get_webview_window(&label) {
        return navigate_workspace_window(app, &existing, host.origin(), &target, true);
    }
    if let Err(error) = open_native_workspace_window(app, host.origin(), &target) {
        let _ = runtimes.stop(&target);
        return Err(error);
    }
    Ok(())
}

fn open_workspace_at_path(
    app: &AppHandle,
    source_window: Option<&WebviewWindow>,
    cwd: &Path,
    resume_session_id: Option<&str>,
) -> Result<(), String> {
    let launcher = app
        .try_state::<WorkspaceLauncher>()
        .ok_or_else(|| "Workspace launcher is not ready".to_string())?;
    let host = app
        .try_state::<HostServer>()
        .ok_or_else(|| "Host server is not ready".to_string())?;
    let runtimes = app
        .try_state::<NativePiManagerState>()
        .ok_or_else(|| "Native runtime manager is not ready".to_string())?;

    let workspace_id = launcher
        .metadata
        .lock()
        .map_err(|_| "Picot metadata store is unavailable".to_string())?
        .workspace_id_for_path(cwd)?;

    host.register_workspace(&workspace_id, cwd.to_path_buf())?;

    // When resuming a saved session, navigate directly to that session id so
    // its history loads; otherwise start a fresh temporary session.
    let target = match resume_session_id {
        Some(id) => RuntimeTarget::new(
            workspace_id.clone(),
            id.to_string(),
            format!("instance-{}", uuid::Uuid::new_v4().simple()),
        ),
        None => spawn_fresh_runtime(&runtimes, &launcher.launch, cwd, workspace_id.clone())?,
    };

    if let Some(window) =
        source_window.filter(|window| window.label().starts_with("native-workspace-"))
    {
        return navigate_workspace_window(
            app,
            window,
            host.origin(),
            &target,
            resume_session_id.is_none(),
        );
    }

    let label = format!("native-workspace-{workspace_id}");
    if let Some(existing) = app.get_webview_window(&label) {
        return navigate_workspace_window(
            app,
            &existing,
            host.origin(),
            &target,
            resume_session_id.is_none(),
        );
    }

    if let Err(error) = open_native_workspace_window(app, host.origin(), &target) {
        if resume_session_id.is_none() {
            let _ = runtimes.stop(&target);
        }
        return Err(error);
    }
    Ok(())
}

fn native_workspace_url(host_origin: &str, target: &RuntimeTarget) -> Result<tauri::Url, String> {
    format!(
        "{}/app/workspaces/{}/sessions/{}",
        host_origin, target.workspace_id, target.session_id
    )
    .parse()
    .map_err(|error| format!("Invalid native Host URL: {error}"))
}

fn set_window_workspace(app: &AppHandle, label: &str, workspace_id: &str) {
    if let Some(state) = app.try_state::<WindowWorkspaceState>() {
        if let Ok(mut windows) = state.0.lock() {
            windows.insert(label.to_string(), workspace_id.to_string());
        }
    }
    if let Some(state) = app.try_state::<FocusedWorkspaceState>() {
        if let Ok(mut focused_workspace) = state.0.lock() {
            *focused_workspace = Some(workspace_id.to_string());
        }
    }
}

fn navigate_workspace_window(
    app: &AppHandle,
    window: &WebviewWindow,
    host_origin: &str,
    target: &RuntimeTarget,
    stop_target_on_error: bool,
) -> Result<(), String> {
    let url = native_workspace_url(host_origin, target)?;
    if let Err(error) = window.navigate(url) {
        if stop_target_on_error {
            if let Some(runtimes) = app.try_state::<NativePiManagerState>() {
                let _ = runtimes.stop(target);
            }
        }
        return Err(error.to_string());
    }
    set_window_workspace(app, window.label(), &target.workspace_id);
    let _ = window.set_focus();
    Ok(())
}

fn open_native_workspace_window(
    app: &AppHandle,
    host_origin: &str,
    target: &RuntimeTarget,
) -> Result<(), String> {
    let label = format!("native-workspace-{}", target.workspace_id);
    let url = native_workspace_url(host_origin, target)?;
    let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))
        .map_err(|error| format!("Failed to load window icon: {error}"))?;
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
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
    let window = builder.build().map_err(|error| error.to_string())?;
    set_window_workspace(app, window.label(), &target.workspace_id);
    Ok(())
}

fn open_fresh_session_for_focused_workspace(app: &AppHandle) -> Result<(), String> {
    let workspace_id = app
        .try_state::<FocusedWorkspaceState>()
        .and_then(|state| state.0.lock().ok().and_then(|guard| guard.clone()))
        .or_else(|| {
            app.webview_windows()
                .values()
                .find(|window| {
                    window.label().starts_with("native-workspace-")
                        && window.is_focused().unwrap_or(false)
                })
                .and_then(|window| {
                    let label = window.label();
                    app.try_state::<WindowWorkspaceState>()
                        .and_then(|state| {
                            state
                                .0
                                .lock()
                                .ok()
                                .and_then(|windows| windows.get(label).cloned())
                        })
                        .or_else(|| label.strip_prefix("native-workspace-").map(str::to_string))
                })
        })
        .ok_or_else(|| "No focused Picot workspace window".to_string())?;
    let host = app
        .try_state::<HostServer>()
        .ok_or_else(|| "Host server is not ready".to_string())?;
    let cwd = host.workspace_root_path(&workspace_id)?;
    open_fresh_session_at_path(app, None, &cwd)
}

fn build_app_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let new_session = MenuItem::with_id(
        app,
        MENU_NEW_SESSION_ID,
        "New Session",
        true,
        Some("CmdOrCtrl+N"),
    )?;
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &new_session,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
            #[cfg(not(target_os = "macos"))]
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    let help = Submenu::with_items(app, "Help", true, &[])?;
    #[cfg(target_os = "macos")]
    {
        let app_menu = Submenu::with_items(
            app,
            app.package_info().name.clone(),
            true,
            &[
                &PredefinedMenuItem::about(app, None, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::services(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::hide(app, None)?,
                &PredefinedMenuItem::hide_others(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::quit(app, None)?,
            ],
        )?;
        let view = Submenu::with_items(
            app,
            "View",
            true,
            &[&PredefinedMenuItem::fullscreen(app, None)?],
        )?;
        Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window, &help])
    }
    #[cfg(not(target_os = "macos"))]
    {
        Menu::with_items(app, &[&file, &edit, &window, &help])
    }
}

fn open_bootstrap_window(app: &AppHandle, startup_error: &str) -> Result<(), String> {
    let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))
        .map_err(|error| format!("Failed to load window icon: {error}"))?;
    let encoded_error = startup_error
        .replace('&', "%26")
        .replace(' ', "%20")
        .replace('\n', "%0A");
    let url = format!("bootstrap.html?startupError={encoded_error}");
    let builder = WebviewWindowBuilder::new(app, "bootstrap", WebviewUrl::App(url.into()))
        .title("Picot")
        .inner_size(900.0, 640.0)
        .min_inner_size(700.0, 480.0)
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

fn list_session_files(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let Ok(entries) = fs::read_dir(root) else {
        return files;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
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
    files
}

fn extract_session_cwd(session_path: &Path) -> Option<String> {
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
            "[picot-native] startup target skipped: sessions dir not found at {}",
            sessions_root.display()
        );
        return None;
    }

    let latest = list_session_files(&sessions_root)
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
    let metadata = Arc::new(Mutex::new(MetadataStore::open(&metadata_path)?));
    let workspace_id = metadata
        .lock()
        .map_err(|_| "Picot metadata store is unavailable".to_string())?
        .workspace_id_for_path(Path::new(&cwd))?;
    let session_id = format!("temporary-{}", uuid::Uuid::new_v4().simple());
    let target = RuntimeTarget::new(
        workspace_id,
        session_id,
        format!("instance-{}", uuid::Uuid::new_v4().simple()),
    );
    let launch_resolver = PiLaunchResolver::new(static_dir.clone());
    let launch = launch_resolver.native_launch_spec(&cwd, session_path.as_deref())?;
    let runtimes = NativePiManager::new(256);
    let remote_auth = Arc::new(Mutex::new(RemoteAuth::new(metadata.clone())));
    let host = tauri::async_runtime::block_on(async {
        let host = HostServer::start_with_workspaces(
            static_dir,
            runtimes.clone(),
            remote_auth,
            std::collections::HashMap::from([(target.workspace_id.clone(), PathBuf::from(&cwd))]),
        )
        .await?;
        runtimes.spawn(target.clone(), launch)?;
        Ok::<HostServer, String>(host)
    })?;
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
    app.manage(WorkspaceLauncher {
        metadata,
        launch: launch_resolver,
    });
    app.manage(FocusedWorkspaceState(Mutex::new(Some(
        target.workspace_id.clone(),
    ))));
    let window_workspaces = HashMap::from([(
        format!("native-workspace-{}", target.workspace_id),
        target.workspace_id.clone(),
    )]);
    app.manage(WindowWorkspaceState(Mutex::new(window_workspaces)));
    Ok(())
}

fn main() {
    if let Err(error) = fix_path_env::fix() {
        eprintln!("[picot] failed to sync PATH from login shell: {error}");
    }

    tauri::Builder::default()
        .menu(build_app_menu)
        .on_menu_event(|app, event| {
            if event.id().as_ref() == MENU_NEW_SESSION_ID {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = open_fresh_session_for_focused_workspace(&app) {
                        log::error!(
                            "[picot-native] failed to open new session from menu: {error}"
                        );
                    }
                });
            }
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            open_folder_as_workspace,
            open_new_session_in_workspace,
            open_session_in_project,
            check_beta_update,
            install_beta_update
        ])
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .level_for("tokio_util", log::LevelFilter::Warn)
                .level_for("hyper", log::LevelFilter::Warn)
                .build(),
        )
        .setup(|app| {
            let static_dir = find_static_dir(app);
            if let Err(error) = setup_native_runtime(app, static_dir) {
                log::error!("[picot-native] startup failed: {error}");
                if let Err(window_error) = open_bootstrap_window(&app.handle().clone(), &error) {
                    log::error!(
                        "[picot-native] failed to open bootstrap window after startup error: {window_error}"
                    );
                    app.dialog()
                        .message(format!(
                            "Picot could not start the embedded pi runtime.\n\n{error}\n\nThe Picot installation may be incomplete or corrupted. Please reinstall Picot and try again."
                        ))
                        .title("Picot startup failed")
                        .kind(MessageDialogKind::Error)
                        .show(|_| {});
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            let label = window.label();
            match event {
                tauri::WindowEvent::Focused(true) if label.starts_with("native-workspace-") => {
                    let workspace_id = window
                        .try_state::<WindowWorkspaceState>()
                        .and_then(|state| {
                            state
                                .0
                                .lock()
                                .ok()
                                .and_then(|windows| windows.get(label).cloned())
                        })
                        .or_else(|| label.strip_prefix("native-workspace-").map(str::to_string));
                    if let (Some(workspace_id), Some(state)) =
                        (workspace_id, window.try_state::<FocusedWorkspaceState>())
                    {
                        if let Ok(mut focused_workspace) = state.0.lock() {
                            *focused_workspace = Some(workspace_id);
                        }
                    }
                }
                tauri::WindowEvent::Destroyed if label.starts_with("native-workspace-") => {
                    let workspace_id = window
                        .try_state::<WindowWorkspaceState>()
                        .and_then(|state| {
                            state
                                .0
                                .lock()
                                .ok()
                                .and_then(|mut windows| windows.remove(label))
                        })
                        .or_else(|| label.strip_prefix("native-workspace-").map(str::to_string));
                    if let Some(workspace_id) = workspace_id {
                        if let Some(state) = window.try_state::<FocusedWorkspaceState>() {
                            if let Ok(mut focused_workspace) = state.0.lock() {
                                if focused_workspace.as_deref() == Some(workspace_id.as_str()) {
                                    *focused_workspace = None;
                                }
                            }
                        }
                        if let Some(manager) = window.try_state::<NativePiManagerState>() {
                            manager.stop_workspace(&workspace_id);
                        }
                    }
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle: &tauri::AppHandle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(manager) = app_handle.try_state::<NativePiManagerState>() {
                    manager.stop_all();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{resolve_static_dir, select_fresh_startup_target};
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_dir(label: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("picot-{label}-{suffix}"))
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
