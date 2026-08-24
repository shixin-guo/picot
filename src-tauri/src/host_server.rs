#![cfg_attr(not(test), allow(dead_code))]

use crate::host_data::{HostDataError, HostDataPlane, WriteFileResult};
use crate::host_git;
use crate::host_router::{ClientKind, HostRouter, RoutedAction, PROTOCOL_VERSION};
use crate::markitdown_preview::{
    ConversionOutcome, DependencyReason, MarkitdownPreviewService, INPUT_BYTE_CAP,
};
use crate::model_health::{self, ModelTestOutcome, ModelTestRequest};
use crate::native_pi_manager::NativePiManager;
use crate::pi_launch::{
    list_installed_apps, open_external, open_in_app, set_package_disabled, PiLaunchResolver,
};
use crate::remote_auth::RemoteAuth;
use crate::runtime_coordinator::{RuntimeStatus, RuntimeTarget};
use crate::terminal_manager::TerminalManager;
use crate::terminal_registry::TerminalRegistry;
use crate::terminal_state_store::TerminalStateStore;
use crate::window_owner::OwnerId;
use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::Query;
use axum::extract::{ConnectInfo, DefaultBodyLimit, Json, State};
use axum::http::header::{
    CACHE_CONTROL, CONTENT_LENGTH, CONTENT_SECURITY_POLICY, CONTENT_TYPE, PRAGMA,
};
use axum::http::StatusCode;
use axum::http::{HeaderMap, HeaderValue, Uri};
use axum::middleware;
use axum::response::{Redirect, Response};
use axum::routing::{get, post};
use axum::Router;
use futures_util::StreamExt;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::collections::HashSet;
use std::convert::Infallible;
use std::fs;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;
use tower::ServiceBuilder;
use tower_http::services::ServeDir;
use tower_http::set_header::SetResponseHeaderLayer;

const MAX_HTTP_BODY_BYTES: usize = 1024 * 1024;
const MAX_WS_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

/// Fingerprints the static bundle by (path, size, mtime) of every file under
/// `static_dir`, without reading file contents — cheap enough to run once on
/// every server startup even for a bundle with vendored JS/fonts/images, and
/// still changes on every real build (build tooling always rewrites file
/// mtimes). Used to version the URL prefix static assets are served under;
/// see the comment at its call site for why the version string alone isn't
/// enough.
fn fingerprint_static_dir(static_dir: &std::path::Path) -> String {
    use sha2::{Digest, Sha256};
    fn walk(dir: &std::path::Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, out);
            } else {
                out.push(path);
            }
        }
    }
    let mut files = Vec::new();
    walk(static_dir, &mut files);
    files.sort();

    let mut hasher = Sha256::new();
    for path in &files {
        let Ok(meta) = fs::metadata(path) else {
            continue;
        };
        if let Ok(relative) = path.strip_prefix(static_dir) {
            hasher.update(relative.to_string_lossy().as_bytes());
        }
        hasher.update(meta.len().to_le_bytes());
        if let Ok(modified) = meta.modified() {
            if let Ok(since_epoch) = modified.duration_since(std::time::UNIX_EPOCH) {
                hasher.update(since_epoch.as_millis().to_le_bytes());
            }
        }
    }
    hex::encode(&hasher.finalize()[..8])
}

struct HostState {
    router: Mutex<HostRouter>,
    runtimes: NativePiManager,
    auth: Arc<Mutex<RemoteAuth>>,
    session_owners: Mutex<std::collections::HashMap<RuntimeTarget, String>>,
    data: HostDataPlane,
    markitdown: MarkitdownPreviewService,
    pi_launch: PiLaunchResolver,
    port: u16,
    terminal_manager: TerminalManager,
    terminal_events: tokio::sync::broadcast::Sender<(OwnerId, Value)>,
    git_service: Arc<crate::git_service::GitService>,
    git_events: tokio::sync::broadcast::Sender<(String, Value)>,
    // Skill source handle registry: pick_skill_source registers an opaque
    // sourceId for a chosen directory; scan/install resolve it by owner before
    // forwarding to the pi process. Paths never leave the host.
    skill_registry: Arc<crate::skill_source_registry::SkillSourceRegistry>,
    // Persistent per-session UI profile (provider/modelId/thinkingLevel).
    // Keyed by session id from the frontend; survives across sessions, used
    // to restore the composer's model + thinking level when a session is
    // reopened. Optional so the constructor stays infallible in tests.
    session_ui_profiles: Arc<crate::session_ui_profile_store::SessionUiProfileStore>,
    install_secret: String,
    app_handle: Option<tauri::AppHandle>,
}

pub struct HostServer {
    origin: String,
    shutdown: Option<oneshot::Sender<()>>,
    state: Arc<HostState>,
}

impl HostServer {
    pub async fn start(
        static_dir: PathBuf,
        runtimes: NativePiManager,
        auth: Arc<Mutex<RemoteAuth>>,
        app_handle: Option<tauri::AppHandle>,
    ) -> Result<Self, String> {
        Self::start_with_workspaces(static_dir, runtimes, auth, HashMap::new(), app_handle).await
    }

    pub async fn start_with_workspaces(
        static_dir: PathBuf,
        runtimes: NativePiManager,
        auth: Arc<Mutex<RemoteAuth>>,
        workspace_roots: HashMap<String, PathBuf>,
        app_handle: Option<tauri::AppHandle>,
    ) -> Result<Self, String> {
        let mut data = HostDataPlane::new(workspace_roots)
            .map_err(|error| format!("Cannot initialize Host data plane: {error:?}"))?;
        if let Some(home) = dirs::home_dir() {
            data = data.with_session_root(home.join(".pi/agent/sessions"));
        }
        // Prefer a stable, high, rarely-used port so LAN clients get a stable
        // URL/QR across restarts. Scan a small contiguous range so multiple
        // project windows each get a deterministic port (57620, 57621, ...),
        // and fall back to an OS-assigned ephemeral port (0) only if the whole
        // preferred range is taken.
        const PREFERRED_PORT_BASE: u16 = 57620;
        const PREFERRED_PORT_COUNT: u16 = 32;
        let mut listener = None;
        for offset in 0..PREFERRED_PORT_COUNT {
            let candidate = PREFERRED_PORT_BASE + offset;
            if let Ok(bound) =
                tokio::net::TcpListener::bind((std::net::Ipv4Addr::UNSPECIFIED, candidate)).await
            {
                listener = Some(bound);
                break;
            }
        }
        let listener = match listener {
            Some(listener) => listener,
            None => tokio::net::TcpListener::bind((std::net::Ipv4Addr::UNSPECIFIED, 0))
                .await
                .map_err(|error| format!("Cannot bind Picot Host: {error}"))?,
        };
        let address = listener
            .local_addr()
            .map_err(|error| format!("Cannot read Picot Host address: {error}"))?;
        // Bind on 0.0.0.0 so LAN clients can reach the server, but always use
        // 127.0.0.1 for the Tauri WebView origin — browsers reject 0.0.0.0 as
        // a destination address.
        let loopback_origin = format!("http://127.0.0.1:{}", address.port());
        let (terminal_events, _) = tokio::sync::broadcast::channel(256);
        let (git_events, _) = tokio::sync::broadcast::channel(256);
        let git_service = Arc::new(crate::git_service::GitService::new());
        let skill_registry = Arc::new(crate::skill_source_registry::SkillSourceRegistry::new());
        // Persistent per-session UI profile (provider/modelId/thinkingLevel).
        // Kept under the same config dir the terminal state store uses so a
        // single ~/.config/picot holds all Picot-owned state.
        let profile_dir = dirs::config_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("picot");
        let session_ui_profiles = Arc::new(
            crate::session_ui_profile_store::SessionUiProfileStore::open(
                profile_dir.join("session-ui-profiles.json"),
            )?,
        );
        let install_secret = {
            use base64::Engine;
            use rand::RngCore;
            let mut bytes = [0u8; 32];
            rand::rngs::OsRng.fill_bytes(&mut bytes);
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
        };
        let terminal_manager = TerminalManager::new(
            TerminalRegistry::new(15),
            TerminalStateStore::new(
                dirs::config_dir()
                    .unwrap_or_else(std::env::temp_dir)
                    .join("picot"),
            ),
        );
        let terminal_event_sender = terminal_events.clone();
        terminal_manager.set_event_sink(Arc::new(move |owner, event| {
            let _ = terminal_event_sender.send((owner.clone(), event));
        }));
        let state = Arc::new(HostState {
            router: Mutex::new(HostRouter::new()),
            runtimes,
            auth,
            session_owners: Mutex::new(std::collections::HashMap::new()),
            data,
            markitdown: MarkitdownPreviewService::default(),
            pi_launch: PiLaunchResolver::new(static_dir.clone()),
            port: address.port(),
            terminal_manager,
            terminal_events,
            git_service,
            git_events,
            skill_registry,
            session_ui_profiles,
            install_secret,
            app_handle,
        });
        let index = static_dir.join("index.html");
        // Serve this build's JS/CSS/HTML under a version-stamped path
        // (`/v/<version>/...`) and point index.html's `<base>` at it. The
        // `Cache-Control: no-store` headers below are meant to stop the
        // WebView from reusing stale assets across an auto-update +
        // relaunch (the host listens on a stable port across restarts), but
        // WebKit has been observed to keep serving a URL's very first
        // cached response indefinitely without ever revalidating it against
        // fresh headers. A version-scoped URL sidesteps that entirely: each
        // release is a guaranteed cache miss for every asset, no matter how
        // the WebView's cache behaves.
        // A version string alone isn't a reliable cache-busting key: a
        // hotfix or dev build can ship with the app version unchanged (no
        // version bump), which would leave the WebView's cache pinned to
        // stale assets exactly like the bug this route exists to avoid. A
        // content fingerprint changes on every real rebuild regardless of
        // whether anyone remembered to bump the version.
        let versioned_prefix = format!("/v/{}", fingerprint_static_dir(&static_dir));
        let index_html = fs::read_to_string(&index).unwrap_or_default().replacen(
            "<base href=\"/\" />",
            &format!("<base href=\"{versioned_prefix}/\" />"),
            1,
        );
        let index_fallback = tower::service_fn(move |_req: axum::extract::Request| {
            let html = index_html.clone();
            std::future::ready(Ok::<_, Infallible>(
                Response::builder()
                    .header(CONTENT_TYPE, "text/html; charset=utf-8")
                    .body(Body::from(html))
                    .expect("static index.html response is well-formed"),
            ))
        });
        let static_service = ServeDir::new(static_dir.clone()).fallback(index_fallback);
        // Always disable caching for the static bundle, not just in debug
        // builds: the host listens on a stable port across app restarts, so
        // after an auto-update + relaunch the WebView's HTTP cache would
        // otherwise keep serving the previous release's JS/CSS/HTML until a
        // manual hard reload.
        let static_service = ServiceBuilder::new()
            .layer(SetResponseHeaderLayer::overriding(
                CACHE_CONTROL,
                HeaderValue::from_static("no-store, no-cache, must-revalidate, max-age=0"),
            ))
            .layer(SetResponseHeaderLayer::overriding(
                PRAGMA,
                HeaderValue::from_static("no-cache"),
            ))
            .service(static_service);
        let versioned_service = ServiceBuilder::new()
            .layer(SetResponseHeaderLayer::overriding(
                CACHE_CONTROL,
                HeaderValue::from_static("no-store, no-cache, must-revalidate, max-age=0"),
            ))
            .layer(SetResponseHeaderLayer::overriding(
                PRAGMA,
                HeaderValue::from_static("no-cache"),
            ))
            .service(ServeDir::new(static_dir));
        let app = Router::new()
            .route("/", get(app_launcher_redirect))
            .route("/health", get(health))
            .route("/health/runtime", get(health_runtime))
            .route("/health/models/test", post(health_model_test))
            .route("/v2/ws", get(websocket_upgrade))
            .route("/v2/bootstrap", get(bootstrap_target))
            .route("/v2/sessions", get(list_all_sessions_http))
            .route("/v2/auth/exchange", post(exchange_pairing))
            .route(
                "/v2/auth/device-requests",
                post(create_device_request).get(list_device_requests),
            )
            .route(
                "/v2/auth/device-requests/{request_id}/claim",
                post(claim_device_request),
            )
            .route(
                "/v2/auth/device-requests/{request_id}/approve",
                post(approve_device_request),
            )
            .route(
                "/v2/auth/device-requests/{request_id}/deny",
                post(deny_device_request),
            )
            .route("/v2/lan-qr", get(lan_qr))
            .route(
                "/api/files/content",
                get(read_file_content).put(write_file_content),
            )
            .route("/api/files/raw", get(raw_file_content))
            .route("/api/git/status", get(git_status))
            .route("/api/git/diff", get(git_file_diff))
            .route("/api/git/stat", get(git_stat_handler))
            .route("/api/file-mentions", get(file_mentions))
            .route("/api/workspace-info", get(workspace_info_handler))
            .route("/v2/new-session", post(new_session))
            .route("/v2/resolve-workspace", post(resolve_workspace))
            .nest_service(&versioned_prefix, versioned_service)
            .fallback_service(static_service)
            .layer(DefaultBodyLimit::max(MAX_HTTP_BODY_BYTES))
            .with_state(state.clone());
        let auth_for_http = state.auth.clone();
        let app = app.layer(middleware::from_fn(
            move |request: axum::extract::Request, next: middleware::Next| {
                let auth = auth_for_http.clone();
                async move {
                    let path = request.uri().path();
                    let public = path == "/"
                        || path == "/health"
                        || path == "/v2/ws"
                        || path == "/v2/auth/exchange"
                        || path == "/v2/auth/device-requests"
                        || path.ends_with("/claim")
                        || path.starts_with("/v/")
                        || path == "/app"
                        || path.starts_with("/app/");
                    if public {
                        return next.run(request).await;
                    }
                    let loopback = request
                        .extensions()
                        .get::<ConnectInfo<std::net::SocketAddr>>()
                        .copied()
                        .map(|peer| {
                            trusted_loopback_request(peer, request.headers(), request.uri())
                        })
                        .unwrap_or(false);
                    let authorized = loopback
                        || request
                            .headers()
                            .get(axum::http::header::AUTHORIZATION)
                            .and_then(|value| value.to_str().ok())
                            .and_then(|value| value.strip_prefix("Bearer "))
                            .and_then(|token| auth.lock().ok()?.authorize(token).ok())
                            .unwrap_or(false);
                    if authorized {
                        next.run(request).await
                    } else {
                        Response::builder()
                            .status(StatusCode::UNAUTHORIZED)
                            .header(CONTENT_TYPE, "application/json")
                            .body(Body::from(r#"{"error":{"code":"unauthorized_device"}}"#))
                            .expect("authorization response is valid")
                    }
                }
            },
        ));
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        tokio::spawn(async move {
            if let Err(error) = axum::serve(
                listener,
                app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await
            {
                log::error!("[picot-host] server stopped unexpectedly: {error}");
            }
        });
        Ok(Self {
            origin: loopback_origin,
            shutdown: Some(shutdown_tx),
            state,
        })
    }

    /// Register a workspace root at runtime so its files, sessions, and cost
    /// data become reachable over the data plane. Used when opening a new
    /// folder as a workspace after startup.
    pub fn register_workspace(&self, workspace_id: &str, root: PathBuf) -> Result<(), String> {
        self.state
            .data
            .register_workspace(workspace_id, root)
            .map_err(|error| format!("Cannot register workspace: {error:?}"))
    }

    pub fn workspace_root_path(&self, workspace_id: &str) -> Result<PathBuf, String> {
        self.state
            .data
            .workspace_root_path(workspace_id)
            .map_err(|error| format!("Cannot resolve workspace path: {error:?}"))
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    pub fn stop(mut self) {
        self.state.terminal_manager.kill_all();
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
}

impl Drop for HostServer {
    fn drop(&mut self) {
        self.state.terminal_manager.kill_all();
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
}

async fn app_launcher_redirect() -> Redirect {
    Redirect::temporary("/app")
}

async fn health(State(state): State<Arc<HostState>>) -> Json<Value> {
    let runtime_count = state.runtimes.statuses().map(|s| s.len()).unwrap_or(0);
    Json(json!({
        "status": "ok",
        "protocolVersion": PROTOCOL_VERSION,
        "piVersion": crate::pi_launch::locked_pi_version(),
        "lanUrl": local_lan_url_with_port(state.port).unwrap_or_default(),
        "runtimeCount": runtime_count,
    }))
}

/// L2 health check — reports the coordinator's live view of every tracked
/// runtime (workspace/session/instance + lifecycle state), plus a summary
/// count broken down by state. Useful for detecting stuck/crashed runtimes
/// without needing to inspect individual sessions.
async fn health_runtime(
    State(state): State<Arc<HostState>>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let statuses = state.runtimes.statuses().map_err(|message| {
        api_error_with_detail(
            StatusCode::INTERNAL_SERVER_ERROR,
            "statuses_unavailable",
            &message,
        )
    })?;
    let mut by_state: HashMap<String, usize> = HashMap::new();
    for status in &statuses {
        let key = serde_json::to_value(status.state)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_else(|| "unknown".to_string());
        *by_state.entry(key).or_insert(0) += 1;
    }
    Ok(Json(json!({
        "status": "ok",
        "runtimeCount": statuses.len(),
        "byState": by_state,
        "runtimes": statuses,
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelTestBody {
    provider_name: String,
    provider: Value,
    model: Value,
}

/// L3 health check — verifies real connectivity to a specific provider/model
/// pair by shelling out to the bundled `pi` CLI with an isolated, throwaway
/// config dir (so no user config, session, or credential state is touched)
/// and a minimal, retry-disabled, non-interactive prompt.
async fn health_model_test(
    State(state): State<Arc<HostState>>,
    Json(body): Json<ModelTestBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let request = ModelTestRequest {
        provider_name: body.provider_name,
        provider: body.provider,
        model: body.model,
    };
    let pi_launch = state.pi_launch.clone();
    let outcome = tokio::task::spawn(async move {
        model_health::run_model_test(&pi_launch, request, model_health::DEFAULT_TEST_TIMEOUT).await
    })
    .await
    .map_err(|error| {
        api_error_with_detail(
            StatusCode::INTERNAL_SERVER_ERROR,
            "model_test_panicked",
            &error.to_string(),
        )
    })?;
    match outcome {
        Ok(outcome) => Ok(Json(model_test_outcome_json(outcome))),
        Err(message) => Err(api_error_with_detail(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            &message,
        )),
    }
}

fn model_test_outcome_json(outcome: ModelTestOutcome) -> Value {
    serde_json::to_value(outcome)
        .unwrap_or_else(|_| json!({ "ok": false, "error": "serialization_failed" }))
}

/// Returns the first non-loopback IPv4 LAN address of this machine,
/// or an empty string if none is found.
fn local_lan_ip() -> Option<std::net::IpAddr> {
    use std::net::{IpAddr, Ipv4Addr, UdpSocket};
    // Cheapest approach: connect a UDP socket to an external addr (no packet
    // is actually sent) and read back which local interface was chosen.
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let local = socket.local_addr().ok()?;
    match local.ip() {
        IpAddr::V4(v4) if !v4.is_loopback() && !v4.is_unspecified() => Some(local.ip()),
        _ => None,
    }
}

/// Returns `None` — the port is only known once the server is bound.
/// Callers that need a full URL must pass the port in separately.
fn local_lan_url_with_port(port: u16) -> Option<String> {
    local_lan_ip().map(|ip| format!("http://{}:{}", ip, port))
}

fn append_pairing_token(url: &mut String, token: &str) {
    let separator = if url.contains('?') { '&' } else { '?' };
    url.push(separator);
    url.push_str("pairingToken=");
    url.push_str(&utf8_percent_encode(token, NON_ALPHANUMERIC).to_string());
}

#[derive(Deserialize)]
struct LanQrQuery {
    path: Option<String>,
}

async fn lan_qr(
    State(state): State<Arc<HostState>>,
    Query(query): Query<LanQrQuery>,
    peer: ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if !trusted_loopback_request(peer, &headers, &uri) {
        return Err(api_error(StatusCode::FORBIDDEN, "loopback_required"));
    }
    let port = state.port;
    let base_url = local_lan_url_with_port(port).unwrap_or_default();
    if base_url.is_empty() {
        return Err((
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "No LAN interface found" })),
        ));
    }
    // Append the session path (e.g. /app/workspaces/{id}/sessions/{id}) if provided.
    let mut url = if let Some(path) = query.path.as_deref() {
        let path = path.trim_start_matches('/');
        format!("{}/{}", base_url.trim_end_matches('/'), path)
    } else {
        base_url.clone()
    };
    let pairing = state
        .auth
        .lock()
        .map_err(|_| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": "Remote auth unavailable" })),
            )
        })?
        .create_pairing(now_seconds());
    append_pairing_token(&mut url, &pairing.token);
    // Build QR code as SVG, then base64-encode it as a data URL.
    let code = qrcode::QrCode::new(url.as_bytes()).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("QR encode failed: {e}") })),
        )
    })?;
    let svg_str = code
        .render()
        .min_dimensions(200, 200)
        .dark_color(qrcode::render::svg::Color("#000000"))
        .light_color(qrcode::render::svg::Color("#ffffff"))
        .build();
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(svg_str.as_bytes());
    let data_url = format!("data:image/svg+xml;base64,{b64}");
    Ok(Json(
        json!({ "dataUrl": data_url, "url": url, "baseUrl": base_url }),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapQuery {
    workspace_id: String,
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionsQuery {
    workspace_id: String,
}

async fn list_all_sessions_http(
    State(state): State<Arc<HostState>>,
    Query(query): Query<SessionsQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let sessions = state
        .data
        .list_all_sessions(&query.workspace_id)
        .map_err(host_data_http_error)?;
    let mut sessions = serde_json::to_value(sessions)
        .map_err(|_| api_error(StatusCode::INTERNAL_SERVER_ERROR, "serialization_failed"))?;
    if let Ok(statuses) = state.runtimes.statuses() {
        annotate_live_sessions(&mut sessions, statuses);
    }
    Ok(Json(json!({ "sessions": sessions })))
}

async fn bootstrap_target(
    State(state): State<Arc<HostState>>,
    Query(query): Query<BootstrapQuery>,
) -> Result<Json<RuntimeTarget>, (StatusCode, Json<Value>)> {
    // A live runtime already exists for this session — reuse it.
    if let Some(target) = state
        .runtimes
        .target_for_session(&query.workspace_id, &query.session_id)
    {
        return Ok(Json(target));
    }

    // Otherwise this is a historical session opened from the sidebar. Lazily
    // spawn a runtime that resumes the saved session file so its messages load
    // instead of failing with "runtime stopped/unavailable".
    let session_path = state
        .data
        .resolve_session_path(&query.workspace_id, &query.session_id)
        .map_err(|_| api_error(StatusCode::INTERNAL_SERVER_ERROR, "session_lookup_failed"))?
        .ok_or_else(|| api_error(StatusCode::NOT_FOUND, "session_not_found"))?;
    let cwd = state
        .data
        .workspace_root_path(&query.workspace_id)
        .map_err(|_| api_error(StatusCode::NOT_FOUND, "workspace_not_found"))?;
    let launch = state
        .pi_launch
        .native_launch_spec(
            &cwd.to_string_lossy(),
            Some(&session_path.to_string_lossy()),
        )
        .map_err(|_| api_error(StatusCode::INTERNAL_SERVER_ERROR, "launch_spec_failed"))?;
    let target = RuntimeTarget::new(
        query.workspace_id.clone(),
        query.session_id.clone(),
        format!("instance-{}", uuid::Uuid::new_v4().simple()),
    );
    state
        .runtimes
        .spawn(target.clone(), launch)
        .map_err(|_| api_error(StatusCode::INTERNAL_SERVER_ERROR, "runtime_spawn_failed"))?;
    Ok(Json(target))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FilePreviewQuery {
    workspace_id: String,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileMentionQuery {
    workspace_id: String,
    query: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteFileContentRequest {
    workspace_id: String,
    path: String,
    content: String,
    expected_mtime_ms: Option<f64>,
    force: Option<bool>,
}

async fn read_file_content(
    State(state): State<Arc<HostState>>,
    Query(query): Query<FilePreviewQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if let Some(source) = state
        .data
        .read_convertible_file(&query.workspace_id, &query.path)
        .map_err(host_data_http_error)?
    {
        let mut response = json!({
            "path": source.path,
            "content": "",
            "size": source.size,
            "mtimeMs": source.mtime_ms,
            "mimeType": source.mime_type,
            "isBinary": false,
            "truncated": false,
            "editable": false,
        });
        let outcome = if source.size > INPUT_BYTE_CAP || source.bytes.len() as u64 > INPUT_BYTE_CAP
        {
            ConversionOutcome::Failed
        } else {
            state.markitdown.convert(&source.suffix, source.bytes).await
        };
        match outcome {
            ConversionOutcome::Ready(markdown) => {
                response["content"] = Value::String(markdown);
                response["previewStatus"] = Value::String("ready".into());
                response["renderAs"] = Value::String("markdown".into());
            }
            ConversionOutcome::DependencyUnavailable {
                reason,
                display_command,
            } => {
                response["previewStatus"] = Value::String("dependencyUnavailable".into());
                let (reason, python_version) = match reason {
                    DependencyReason::PythonMissing => ("pythonMissing", None),
                    DependencyReason::PythonTooOld { version } => ("pythonTooOld", Some(version)),
                    DependencyReason::MarkitdownMissing => ("markitdownMissing", None),
                    DependencyReason::MarkitdownIncompatible => ("markitdownIncompatible", None),
                };
                response["dependencyReason"] = Value::String(reason.into());
                if let Some(version) = python_version {
                    response["pythonVersion"] = Value::String(version);
                }
                if let Some(command) = display_command {
                    response["displayCommand"] = Value::String(command);
                }
            }
            ConversionOutcome::Failed => {
                response["previewStatus"] = Value::String("conversionFailed".into());
            }
        }
        return Ok(Json(response));
    }
    let content = state
        .data
        .read_file_content(&query.workspace_id, &query.path)
        .map_err(host_data_http_error)?;
    serde_json::to_value(content)
        .map(Json)
        .map_err(|_| api_error(StatusCode::INTERNAL_SERVER_ERROR, "serialization_failed"))
}

async fn raw_file_content(
    State(state): State<Arc<HostState>>,
    Query(query): Query<FilePreviewQuery>,
) -> Result<Response, (StatusCode, Json<Value>)> {
    let raw = state
        .data
        .raw_file_content(&query.workspace_id, &query.path)
        .map_err(host_data_http_error)?;
    let mut response = Response::new(Body::from(raw.bytes));
    *response.status_mut() = StatusCode::OK;
    let headers = response.headers_mut();
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_str(&raw.mime_type)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    headers.insert(
        CONTENT_LENGTH,
        HeaderValue::from_str(&raw.size.to_string())
            .unwrap_or_else(|_| HeaderValue::from_static("0")),
    );
    headers.insert(
        CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("sandbox; default-src 'none'; style-src 'unsafe-inline'"),
    );
    Ok(response)
}

async fn file_mentions(
    State(state): State<Arc<HostState>>,
    Query(query): Query<FileMentionQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let result = state
        .data
        .search_file_mentions(&query.workspace_id, &query.query)
        .map_err(host_data_http_error)?;
    serde_json::to_value(result)
        .map(Json)
        .map_err(|_| api_error(StatusCode::INTERNAL_SERVER_ERROR, "serialization_failed"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitStatusQuery {
    workspace_id: String,
}

async fn git_status(
    State(state): State<Arc<HostState>>,
    Query(query): Query<GitStatusQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let result = state
        .data
        .git_status(&query.workspace_id)
        .map_err(host_data_http_error)?;
    serde_json::to_value(result)
        .map(Json)
        .map_err(|_| api_error(StatusCode::INTERNAL_SERVER_ERROR, "serialization_failed"))
}

async fn git_file_diff(
    State(state): State<Arc<HostState>>,
    Query(query): Query<FilePreviewQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let result = state
        .data
        .git_file_diff(&query.workspace_id, &query.path)
        .map_err(host_data_http_error)?;
    serde_json::to_value(result)
        .map(Json)
        .map_err(|_| api_error(StatusCode::INTERNAL_SERVER_ERROR, "serialization_failed"))
}

async fn git_stat_handler(
    State(state): State<Arc<HostState>>,
    Query(query): Query<GitStatusQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let result = state
        .data
        .git_stat(&query.workspace_id)
        .map_err(host_data_http_error)?;
    serde_json::to_value(result)
        .map(Json)
        .map_err(|_| api_error(StatusCode::INTERNAL_SERVER_ERROR, "serialization_failed"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceInfoQuery {
    workspace_id: Option<String>,
    workspace_path: Option<String>,
}

async fn workspace_info_handler(
    State(state): State<Arc<HostState>>,
    Query(query): Query<WorkspaceInfoQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    // The sidebar passes the workspace's on-disk path (projectPath), not
    // the internal workspace ID. Try both: first by workspace_id (when
    // available), then fall back to treating workspace_path as the root.
    let result = if let Some(ws_id) = &query.workspace_id {
        state.data.workspace_info(ws_id)
    } else if let Some(ws_path) = &query.workspace_path {
        state.data.workspace_info_by_path(ws_path)
    } else {
        Err(HostDataError::UnknownWorkspace)
    }
    .map_err(host_data_http_error)?;
    serde_json::to_value(result)
        .map(Json)
        .map_err(|_| api_error(StatusCode::INTERNAL_SERVER_ERROR, "serialization_failed"))
}

async fn write_file_content(
    State(state): State<Arc<HostState>>,
    Json(body): Json<WriteFileContentRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let force = body.force.unwrap_or(false);
    let Some(expected_mtime_ms) = body.expected_mtime_ms.or(force.then_some(0.0)) else {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "expected_mtime_ms_required",
        ));
    };
    match state
        .data
        .write_file_content(
            &body.workspace_id,
            &body.path,
            &body.content,
            expected_mtime_ms,
            force,
        )
        .map_err(host_data_http_error)?
    {
        WriteFileResult::Saved { size, mtime_ms } => Ok(Json(json!({
            "path": body.path,
            "size": size,
            "mtimeMs": mtime_ms,
        }))),
        WriteFileResult::Conflict => Err(api_error(StatusCode::CONFLICT, "conflict")),
        WriteFileResult::Invalid => Err(api_error(StatusCode::BAD_REQUEST, "invalid_file")),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewSessionRequest {
    workspace_id: String,
}

/// POST /v2/new-session — spawn a fresh temporary runtime for `workspaceId`.
/// Used by LAN/remote clients that cannot invoke Tauri native commands.
async fn new_session(
    State(state): State<Arc<HostState>>,
    Json(body): Json<NewSessionRequest>,
) -> Result<Json<RuntimeTarget>, (StatusCode, Json<Value>)> {
    let cwd = state
        .data
        .workspace_root_path(&body.workspace_id)
        .map_err(|_| api_error(StatusCode::NOT_FOUND, "workspace_not_found"))?;
    let session_id = format!("temporary-{}", uuid::Uuid::new_v4().simple());
    let instance_id = format!("instance-{}", uuid::Uuid::new_v4().simple());
    let target = RuntimeTarget::new(body.workspace_id.clone(), session_id, instance_id);
    let cwd_str = cwd.to_string_lossy().into_owned();
    let launch = state
        .pi_launch
        .native_launch_spec(&cwd_str, None)
        .map_err(|_| api_error(StatusCode::INTERNAL_SERVER_ERROR, "launch_spec_failed"))?;
    state
        .runtimes
        .spawn(target.clone(), launch)
        .map_err(|_| api_error(StatusCode::INTERNAL_SERVER_ERROR, "runtime_spawn_failed"))?;
    Ok(Json(target))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveWorkspaceRequest {
    project_path: String,
}

fn resolve_workspace_path(state: &HostState, project_path: &str) -> Result<String, &'static str> {
    let path = PathBuf::from(project_path);
    if !path.is_dir() {
        return Err("project_not_found");
    }
    let workspace_id = state
        .auth
        .lock()
        .map_err(|_| "auth_unavailable")?
        .resolve_workspace(&path)
        .map_err(|_| "workspace_resolve_failed")?;
    state
        .data
        .register_workspace(&workspace_id, path)
        .map_err(|_| "workspace_register_failed")?;
    Ok(workspace_id)
}

/// POST /v2/resolve-workspace — map a project path to its stable workspace id
/// and register the workspace root so subsequent `/v2/bootstrap` calls can
/// lazily resume its sessions. Used by LAN/mobile clients switching to a
/// session that belongs to a different project (no Tauri window mechanism).
async fn resolve_workspace(
    State(state): State<Arc<HostState>>,
    Json(body): Json<ResolveWorkspaceRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let workspace_id = resolve_workspace_path(&state, &body.project_path).map_err(|code| {
        let status = if code == "project_not_found" {
            StatusCode::NOT_FOUND
        } else {
            StatusCode::INTERNAL_SERVER_ERROR
        };
        api_error(status, code)
    })?;
    Ok(Json(json!({ "workspaceId": workspace_id })))
}

async fn websocket_upgrade(
    State(state): State<Arc<HostState>>,
    peer: ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
    websocket: WebSocketUpgrade,
) -> Response {
    let loopback = trusted_loopback_request(peer, &headers, &uri);
    websocket
        .max_message_size(MAX_WS_MESSAGE_BYTES)
        .on_upgrade(move |socket| handle_websocket(socket, state, loopback))
}

async fn handle_websocket(mut socket: WebSocket, state: Arc<HostState>, loopback_peer: bool) {
    let Some(Ok(Message::Text(first))) = socket.next().await else {
        return;
    };
    let hello = match serde_json::from_str::<Value>(&first) {
        Ok(frame) => frame,
        Err(_) => {
            let _ = send_error(&mut socket, None, "invalid_json", "Invalid JSON frame").await;
            return;
        }
    };
    let client_id = match hello.get("clientId").and_then(Value::as_str) {
        Some(value) if !value.is_empty() => value.to_owned(),
        _ => {
            let _ = send_error(
                &mut socket,
                None,
                "invalid_client_id",
                "clientId is required",
            )
            .await;
            return;
        }
    };
    if !loopback_peer {
        let authorized = hello
            .get("deviceToken")
            .and_then(Value::as_str)
            .and_then(|token| state.auth.lock().ok()?.authorize(token).ok())
            .unwrap_or(false);
        if !authorized {
            let _ = send_error(
                &mut socket,
                None,
                "unauthorized_device",
                "Device token rejected",
            )
            .await;
            return;
        }
    }
    let handshake = state
        .router
        .lock()
        .map_err(|_| "Host router unavailable".to_string())
        .and_then(|mut router| {
            router
                .connect_as(
                    &client_id,
                    &hello,
                    if loopback_peer {
                        ClientKind::Desktop
                    } else {
                        ClientKind::Remote
                    },
                )
                .map_err(|error| error.message)
        });
    if let Err(message) = handshake {
        let _ = send_error(&mut socket, None, "handshake_rejected", &message).await;
        return;
    }
    let terminal_owner = OwnerId::from_client_id(&client_id);
    if socket
        .send(Message::Text(
            json!({ "type": "hello_ack", "protocolVersion": PROTOCOL_VERSION })
                .to_string()
                .into(),
        ))
        .await
        .is_err()
    {
        return;
    }

    let mut runtime_events = state.runtimes.subscribe();
    let mut terminal_events = state.terminal_events.subscribe();
    let mut git_events = state.git_events.subscribe();
    let mut subscriptions = HashSet::new();
    loop {
        tokio::select! {
            incoming = socket.next() => {
                let Some(Ok(message)) = incoming else { break };
                let Message::Text(text) = message else {
                    if matches!(message, Message::Close(_)) { break; }
                    continue;
                };
                let frame = match serde_json::from_str::<Value>(&text) {
                    Ok(frame) => frame,
                    Err(_) => {
                        let _ = send_error(&mut socket, None, "invalid_json", "Invalid JSON frame").await;
                        continue;
                    }
                };
                let request_id = frame
                    .get("requestId")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let routed = state
                    .router
                    .lock()
                    .map_err(|_| ("router_unavailable", "Host router unavailable".to_string()))
                    .and_then(|router| {
                        router
                            .route(&client_id, &frame)
                            .map_err(|error| (error.code, error.message))
                    });
                let mut after_response = Vec::new();
                let response = match routed {
                    Ok(RoutedAction::Subscribe { request_id, target, .. }) => {
                        match serde_json::from_value::<RuntimeTarget>(target) {
                            Ok(target) => {
                                subscriptions.insert(target.clone());
                                let owns_session = state
                                    .session_owners
                                    .lock()
                                    .map(|mut owners| {
                                        owners.entry(target.clone()).or_insert_with(|| client_id.clone()) == &client_id
                                    })
                                    .unwrap_or(false);
                                if owns_session {
                                    if let Ok(pending) = state.runtimes.pending_extension_ui(&target) {
                                        after_response.extend(pending.into_iter().map(runtime_event_frame));
                                    }
                                }
                                Ok(json!({ "type": "runtime_subscribed", "requestId": request_id }))
                            }
                            Err(_) => Err(("invalid_target", "Runtime target is invalid".into())),
                        }
                    }
                    Ok(action) => dispatch(action, &state).await,
                    Err((code, message)) => Err((code, message)),
                };
                let outgoing = match response {
                    Ok(value) => value,
                    Err((code, message)) => structured_error(request_id.as_deref(), code, &message),
                };
                if socket.send(Message::Text(outgoing.to_string().into())).await.is_err() {
                    break;
                }
                for replay in after_response {
                    if socket.send(Message::Text(replay.to_string().into())).await.is_err() {
                        return;
                    }
                }
            }
            event = runtime_events.recv() => {
                match event {
                    Ok(event) if subscriptions.contains(&event.target) => {
                        if extension_ui_requires_owner(&event.event) {
                            let is_owner = state
                                .session_owners
                                .lock()
                                .ok()
                                .and_then(|owners| owners.get(&event.target).cloned())
                                .as_deref()
                                == Some(client_id.as_str());
                            if !is_owner { continue; }
                        }
                        let outgoing = runtime_event_frame(event);
                        if socket.send(Message::Text(outgoing.to_string().into())).await.is_err() {
                            break;
                        }
                    }
                    Ok(_) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        let outgoing = structured_error(
                            None,
                            "event_sequence_gap",
                            "Runtime events were missed; request a snapshot",
                        );
                        if socket.send(Message::Text(outgoing.to_string().into())).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            event = terminal_events.recv() => {
                match event {
                    Ok((owner, outgoing)) if owner == terminal_owner => {
                        if socket.send(Message::Text(outgoing.to_string().into())).await.is_err() {
                            break;
                        }
                    }
                    Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            event = git_events.recv() => {
                match event {
                    Ok((owner, outgoing)) if owner == client_id => {
                        if socket.send(Message::Text(outgoing.to_string().into())).await.is_err() {
                            break;
                        }
                    }
                    Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
    if let Ok(mut owners) = state.session_owners.lock() {
        owners.retain(|_, owner| owner != &client_id);
    }
}

fn extension_ui_requires_owner(event: &Value) -> bool {
    if event.get("type").and_then(Value::as_str) != Some("extension_ui_request") {
        return false;
    }
    matches!(
        event.get("method").and_then(Value::as_str),
        Some("select" | "confirm" | "input" | "editor")
    )
}

fn runtime_event_frame(event: crate::native_pi_manager::NativeRuntimeEvent) -> Value {
    json!({
        "type": "runtime_event",
        "target": event.target,
        "sequence": event.sequence,
        "event": event.event,
    })
}

fn annotate_live_sessions(sessions: &mut Value, statuses: Vec<RuntimeStatus>) {
    let Some(items) = sessions.as_array_mut() else {
        return;
    };
    for session in items {
        let Some(session_id) = session.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some(status) = statuses
            .iter()
            .find(|status| status.target.session_id == session_id)
        else {
            continue;
        };
        session["target"] = json!(status.target);
        session["status"] = json!(status.state);
    }
}

fn messages_from_entries_response(response: &Value) -> Value {
    let Some(entries) = response.pointer("/data/entries").and_then(Value::as_array) else {
        return json!([]);
    };
    let leaf_id = response.pointer("/data/leafId").and_then(Value::as_str);
    let mut id_to_index = HashMap::new();
    for (index, entry) in entries.iter().enumerate() {
        if let Some(id) = entry.get("id").and_then(Value::as_str) {
            id_to_index.insert(id, index);
        }
    }

    let mut branch = Vec::new();
    let mut current = leaf_id.and_then(|id| id_to_index.get(id).copied());
    let mut visited = HashSet::new();
    while let Some(index) = current {
        if !visited.insert(index) {
            break;
        }
        let entry = &entries[index];
        if entry.get("type").and_then(Value::as_str) == Some("message") {
            if let Some(message) = entry.get("message") {
                branch.push(message_with_entry_id(
                    message.clone(),
                    entry.get("id").and_then(Value::as_str),
                ));
            }
        }
        current = entry
            .get("parentId")
            .and_then(Value::as_str)
            .and_then(|parent_id| id_to_index.get(parent_id).copied());
    }

    branch.reverse();
    Value::Array(branch)
}

fn message_with_entry_id(mut message: Value, entry_id: Option<&str>) -> Value {
    if message.get("role").and_then(Value::as_str) != Some("user") {
        return message;
    }
    let Some(entry_id) = entry_id else {
        return message;
    };
    if let Some(object) = message.as_object_mut() {
        object.insert("entryId".to_owned(), Value::String(entry_id.to_owned()));
    }
    message
}

async fn dispatch(
    action: RoutedAction,
    state: &HostState,
) -> Result<Value, (&'static str, String)> {
    match action {
        RoutedAction::Runtime {
            client_id,
            request_id,
            frame,
        } => {
            if frame.get("type").and_then(Value::as_str) == Some("runtime_snapshot_request") {
                let session_id = frame
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .ok_or(("invalid_session", "sessionId is required".into()))?;
                let mut target = state
                    .runtimes
                    .target_for_session_id(session_id)
                    .ok_or(("runtime_not_found", "Runtime session is not running".into()))?;
                let state_response = state
                    .runtimes
                    .request(
                        &target,
                        json!({ "type": "get_state" }),
                        None,
                        Duration::from_secs(10),
                    )
                    .await
                    .map_err(|message| ("snapshot_failed", message))?;
                if target.session_id.starts_with("temporary-") {
                    if let Some(formal_session_id) = state_response
                        .pointer("/data/sessionId")
                        .and_then(Value::as_str)
                        .filter(|session_id| !session_id.is_empty())
                    {
                        target = state
                            .runtimes
                            .bind_session_id(&target, formal_session_id)
                            .map_err(|message| ("session_binding_failed", message))?;
                    }
                }
                let entries_response = state
                    .runtimes
                    .request(
                        &target,
                        json!({ "type": "get_entries" }),
                        None,
                        Duration::from_secs(10),
                    )
                    .await
                    .map_err(|message| ("snapshot_failed", message))?;
                let messages = messages_from_entries_response(&entries_response);
                let host_snapshot = state
                    .runtimes
                    .snapshot(&target)
                    .map_err(|message| ("snapshot_failed", message))?;
                return Ok(json!({
                    "type": "runtime_snapshot",
                    "requestId": request_id,
                    "target": target,
                    "sequence": host_snapshot.sequence,
                    "state": {
                        "lifecycle": host_snapshot.state,
                        "pi": state_response.get("data").cloned().unwrap_or(Value::Null),
                        "messages": messages,
                    }
                }));
            }
            if frame.get("type").and_then(Value::as_str) == Some("runtime_capabilities_request") {
                return Ok(json!({
                    "type": "runtime_capabilities",
                    "requestId": request_id,
                    "protocolVersion": PROTOCOL_VERSION,
                    "nativeRpc": true,
                    "extensionUi": true,
                    "sessionTree": true,
                    "oauth": false,
                    "hostDataPlane": true,
                    "sourcePreservingFork": false,
                }));
            }
            if frame.get("type").and_then(Value::as_str) != Some("runtime_request") {
                return Err((
                    "unsupported_runtime_request",
                    "Unsupported runtime request".into(),
                ));
            }
            let target: RuntimeTarget = serde_json::from_value(
                frame
                    .get("target")
                    .cloned()
                    .ok_or(("invalid_target", "Runtime target is required".into()))?,
            )
            .map_err(|_| ("invalid_target", "Runtime target is invalid".into()))?;
            let command = frame
                .get("command")
                .cloned()
                .ok_or(("invalid_command", "Runtime command is required".into()))?;
            if command.get("type").and_then(Value::as_str) == Some("extension_ui_response") {
                let is_owner = state
                    .session_owners
                    .lock()
                    .map_err(|_| {
                        (
                            "dialog_owner_unavailable",
                            "Dialog owner unavailable".into(),
                        )
                    })?
                    .get(&target)
                    .is_some_and(|owner| owner == &client_id);
                if !is_owner {
                    return Err((
                        "dialog_response_forbidden",
                        "Only the owning client may answer this dialog".into(),
                    ));
                }
                state
                    .runtimes
                    .respond_extension_ui(&target, command)
                    .await
                    .map_err(|message| ("dialog_response_failed", message))?;
                return Ok(json!({
                    "type": "runtime_response",
                    "requestId": request_id,
                    "acceptance": "completed",
                    "response": { "success": true },
                }));
            }
            let idempotency_key = frame.get("idempotencyKey").and_then(Value::as_str);
            if let Ok(mut owners) = state.session_owners.lock() {
                owners.insert(target.clone(), client_id);
            }
            let response = state
                .runtimes
                .request(&target, command, idempotency_key, Duration::from_secs(30))
                .await
                .map_err(|message| ("runtime_request_failed", message))?;
            Ok(json!({
                "type": "runtime_response",
                "requestId": request_id,
                "acceptance": "accepted",
                "response": response,
            }))
        }
        RoutedAction::Git {
            client_id,
            request_id,
            frame,
        } => {
            host_git::dispatch(
                &state.git_service,
                &state.data,
                &state.pi_launch,
                &state.git_events,
                &client_id,
                &request_id,
                &frame,
            )
            .await
        }
        RoutedAction::Terminal {
            client_id,
            request_id,
            frame,
        } => {
            let workspace_id = frame
                .get("workspaceId")
                .and_then(Value::as_str)
                .ok_or(("invalid_workspace", "workspaceId is required".into()))?;
            let workspace_root = state
                .data
                .workspace_root_path(workspace_id)
                .map_err(host_data_error)?;
            let payload = frame
                .get("payload")
                .ok_or(("invalid_terminal_command", "payload is required".into()))?;
            let owner = OwnerId::from_client_id(&client_id);
            let mut response = state
                .terminal_manager
                .dispatch(&owner, &workspace_root, payload)
                .map_err(|message| ("terminal_command_failed", message))?;
            if let Some(object) = response.as_object_mut() {
                object.insert("requestId".into(), Value::String(request_id));
            }
            Ok(response)
        }
        RoutedAction::Auth {
            request_id, frame, ..
        } => match frame.get("operation").and_then(Value::as_str) {
            Some("create_pairing") => {
                let pairing = state
                    .auth
                    .lock()
                    .map_err(|_| ("auth_unavailable", "Remote auth unavailable".into()))?
                    .create_pairing(now_seconds());
                Ok(json!({
                    "type": "auth_response",
                    "requestId": request_id,
                    "pairingToken": pairing.token,
                    "expiresAt": pairing.expires_at,
                }))
            }
            _ => Err((
                "unknown_auth_operation",
                "Unsupported auth operation".into(),
            )),
        },
        RoutedAction::Host {
            client_id,
            request_id,
            operation,
            frame,
            ..
        } => dispatch_host_operation(state, &client_id, &request_id, &operation, &frame).await,
        RoutedAction::Data {
            request_id, frame, ..
        } => match frame.get("operation").and_then(Value::as_str) {
            Some("list_files") => {
                let workspace_id = frame
                    .get("workspaceId")
                    .and_then(Value::as_str)
                    .ok_or(("invalid_workspace", "workspaceId is required".into()))?;
                let relative_path = frame
                    .get("path")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let entries = state
                    .data
                    .list_files(workspace_id, relative_path)
                    .map_err(host_data_error)?;
                Ok(json!({
                    "type": "data_response",
                    "requestId": request_id,
                    "operation": "list_files",
                    "entries": entries,
                }))
            }
            Some("list_sessions") => {
                let workspace_id = frame
                    .get("workspaceId")
                    .and_then(Value::as_str)
                    .ok_or(("invalid_workspace", "workspaceId is required".into()))?;
                let sessions = state
                    .data
                    .list_sessions(workspace_id)
                    .map_err(host_data_error)?;
                Ok(json!({
                    "type": "data_response",
                    "requestId": request_id,
                    "operation": "list_sessions",
                    "sessions": sessions,
                }))
            }
            Some("list_all_sessions") => {
                let workspace_id = frame
                    .get("workspaceId")
                    .and_then(Value::as_str)
                    .ok_or(("invalid_workspace", "workspaceId is required".into()))?;
                let sessions = state
                    .data
                    .list_all_sessions(workspace_id)
                    .map_err(host_data_error)?;
                let mut sessions = serde_json::to_value(sessions)
                    .map_err(|error| ("serialization_failed", error.to_string()))?;
                if let Ok(statuses) = state.runtimes.statuses() {
                    annotate_live_sessions(&mut sessions, statuses);
                }
                Ok(json!({
                    "type": "data_response",
                    "requestId": request_id,
                    "operation": "list_all_sessions",
                    "sessions": sessions,
                }))
            }
            Some("list_launcher_sessions") => {
                let sessions = state
                    .data
                    .list_launcher_sessions()
                    .map_err(host_data_error)?;
                let mut sessions = serde_json::to_value(sessions)
                    .map_err(|error| ("serialization_failed", error.to_string()))?;
                if let Ok(statuses) = state.runtimes.statuses() {
                    annotate_live_sessions(&mut sessions, statuses);
                }
                Ok(json!({
                    "type": "data_response",
                    "requestId": request_id,
                    "operation": "list_launcher_sessions",
                    "sessions": sessions,
                }))
            }
            Some("search_sessions") => {
                let workspace_id = frame
                    .get("workspaceId")
                    .and_then(Value::as_str)
                    .ok_or(("invalid_workspace", "workspaceId is required".into()))?;
                let query = frame.get("query").and_then(Value::as_str).unwrap_or("");
                let results = state
                    .data
                    .search_sessions(workspace_id, query)
                    .map_err(host_data_error)?;
                Ok(json!({
                    "type": "data_response",
                    "requestId": request_id,
                    "operation": "search_sessions",
                    "results": results,
                }))
            }
            Some("cost_dashboard") => {
                let workspace_id = frame
                    .get("workspaceId")
                    .and_then(Value::as_str)
                    .ok_or(("invalid_workspace", "workspaceId is required".into()))?;
                let dashboard = state
                    .data
                    .cost_dashboard(workspace_id)
                    .map_err(host_data_error)?;
                Ok(json!({
                    "type": "data_response",
                    "requestId": request_id,
                    "operation": "cost_dashboard",
                    "dashboard": dashboard,
                }))
            }
            Some("read_session_messages") => {
                let workspace_id = frame
                    .get("workspaceId")
                    .and_then(Value::as_str)
                    .ok_or(("invalid_workspace", "workspaceId is required".into()))?;
                let session_id = frame
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .ok_or(("invalid_session", "sessionId is required".into()))?;
                let messages = state
                    .data
                    .read_session_messages(workspace_id, session_id)
                    .map_err(host_data_error)?;
                Ok(json!({
                    "type": "data_response",
                    "requestId": request_id,
                    "operation": "read_session_messages",
                    "messages": messages,
                }))
            }
            Some("workspace_info") => {
                let workspace_id = frame
                    .get("workspaceId")
                    .and_then(Value::as_str)
                    .ok_or(("invalid_workspace", "workspaceId is required".into()))?;
                let info = state
                    .data
                    .workspace_info(workspace_id)
                    .map_err(host_data_error)?;
                Ok(json!({
                    "type": "data_response",
                    "requestId": request_id,
                    "operation": "workspace_info",
                    "info": info,
                }))
            }
            _ => Err((
                "unknown_data_operation",
                "Unsupported data operation".into(),
            )),
        },
        RoutedAction::Subscribe { request_id, .. } => Ok(json!({
            "type": "runtime_subscribed",
            "requestId": request_id,
        })),
    }
}

async fn dispatch_host_operation(
    state: &HostState,
    client_id: &str,
    request_id: &str,
    operation: &str,
    frame: &Value,
) -> Result<Value, (&'static str, String)> {
    match operation {
        "list_pi_packages" => {
            let resolver = state.pi_launch.clone();
            let packages = tokio::task::spawn_blocking(move || resolver.list_pi_packages())
                .await
                .map_err(|error| ("host_operation_failed", error.to_string()))?
                .map_err(|message| ("list_pi_packages_failed", message))?;
            Ok(json!({
                "type": "host_response",
                "requestId": request_id,
                "operation": "list_pi_packages",
                "packages": packages,
            }))
        }
        "install_pi_package" | "remove_pi_package" | "update_pi_package" => {
            let source = frame
                .get("source")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or(("invalid_source", "Package source cannot be empty".into()))?
                .to_owned();
            let local = frame.get("local").and_then(Value::as_bool).unwrap_or(false);
            let resolver = state.pi_launch.clone();
            let operation = operation.to_string();
            let operation_ref = operation.clone();
            tokio::task::spawn_blocking(move || match operation_ref.as_str() {
                "install_pi_package" => resolver.install_pi_package(&source, local),
                "remove_pi_package" => resolver.remove_pi_package(&source, local),
                "update_pi_package" => resolver.update_pi_package(&source),
                _ => unreachable!(),
            })
            .await
            .map_err(|error| ("host_operation_failed", error.to_string()))?
            .map_err(|message| ("package_operation_failed", message))?;
            Ok(json!({
                "type": "host_response",
                "requestId": request_id,
                "operation": operation,
                "ok": true,
            }))
        }
        "set_pi_package_disabled" => {
            let source = frame
                .get("source")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or(("invalid_source", "Package source cannot be empty".into()))?
                .to_owned();
            let disabled = frame
                .get("disabled")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let scope = frame
                .get("scope")
                .and_then(Value::as_str)
                .unwrap_or("global")
                .to_owned();
            let cwd = frame
                .get("cwd")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            let changed = tokio::task::spawn_blocking(move || {
                set_package_disabled(&scope, &cwd, &source, disabled)
            })
            .await
            .map_err(|error| ("host_operation_failed", error.to_string()))?
            .map_err(|message| ("set_pi_package_disabled_failed", message))?;
            Ok(json!({
                "type": "host_response",
                "requestId": request_id,
                "operation": "set_pi_package_disabled",
                "ok": true,
                "changed": changed,
            }))
        }
        "list_installed_apps" => Ok(json!({
            "type": "host_response",
            "requestId": request_id,
            "operation": "list_installed_apps",
            "apps": list_installed_apps(),
        })),
        "open_in_app" => {
            let path = frame
                .get("path")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or(("invalid_path", "path is required".into()))?;
            let app_name = frame
                .get("appName")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let command = frame
                .get("command")
                .and_then(Value::as_str)
                .map(str::to_owned);
            tokio::task::spawn_blocking(move || {
                open_in_app(&path, app_name.as_deref(), command.as_deref())
            })
            .await
            .map_err(|error| ("host_operation_failed", error.to_string()))?
            .map_err(|message| ("open_in_app_failed", message))?;
            Ok(json!({
                "type": "host_response",
                "requestId": request_id,
                "operation": "open_in_app",
                "ok": true,
            }))
        }
        "open_external" => {
            let url = frame
                .get("url")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or(("invalid_url", "url is required".into()))?;
            tokio::task::spawn_blocking(move || open_external(&url))
                .await
                .map_err(|error| ("host_operation_failed", error.to_string()))?
                .map_err(|message| ("open_external_failed", message))?;
            Ok(json!({
                "type": "host_response",
                "requestId": request_id,
                "operation": "open_external",
                "ok": true,
            }))
        }
        "resolve_workspace" => {
            let project_path = frame
                .get("projectPath")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or(("invalid_project_path", "projectPath is required".into()))?;
            let workspace_id = resolve_workspace_path(state, project_path)
                .map_err(|code| (code, code.replace('_', " ")))?;
            Ok(json!({
                "type": "host_response",
                "requestId": request_id,
                "operation": "resolve_workspace",
                "workspaceId": workspace_id,
            }))
        }
        "delete_sessions" => {
            let session_ids: Vec<String> = frame
                .get("sessionIds")
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            let data = state.data.clone();
            let result = tokio::task::spawn_blocking(move || data.delete_sessions(&session_ids))
                .await
                .map_err(|error| ("host_operation_failed", error.to_string()))?
                .map_err(host_data_error)?;
            Ok(json!({
                "type": "host_response",
                "requestId": request_id,
                "operation": "delete_sessions",
                "deleted": result.deleted,
                "errors": result.errors,
            }))
        }
        "pick_skill_source" => {
            // Picker must never expose the chosen path to the browser. The host
            // opens the OS folder dialog, canonicalizes the selection, and
            // registers an opaque sourceId in SkillSourceRegistry keyed by the
            // requesting owner + workspace. Only the sourceId crosses the wire.
            let Some(app) = state.app_handle.clone() else {
                return Err((
                    "host_operation_failed",
                    "Folder picker is not available".into(),
                ));
            };
            let workspace_id = frame
                .get("workspaceId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or((
                    "invalid_workspace",
                    "workspaceId is required to pick a skill source".into(),
                ))?
                .to_owned();
            let workspace_root = state
                .data
                .workspace_root_path(&workspace_id)
                .map_err(host_data_error)?;
            let owner_id = crate::window_owner::OwnerId::from_client_id(client_id);
            // The native host runs one Pi process per workspace on a single
            // host port, so workspace_port is the host port itself and
            // workspace_generation stays 0 (no multi-generation swap in the
            // native architecture). The window_label is the client_id — it
            // only needs to be unique per desktop window.
            let port = state.port;
            let generation = 0u64;
            let window_label = client_id.to_owned();
            let path =
                tokio::task::spawn_blocking(move || app.dialog().file().blocking_pick_folder())
                    .await
                    .map_err(|error| ("host_operation_failed", error.to_string()))?;
            let Some(picked) = path else {
                return Ok(json!({
                    "type": "host_response",
                    "requestId": request_id,
                    "operation": "pick_skill_source",
                    "sourceId": null,
                }));
            };
            let canonical_path = picked
                .as_path()
                .ok_or(("invalid_path", "Selected folder is not a local path".into()))?
                .to_path_buf();
            let registry = state.skill_registry.clone();
            let source_id = tokio::task::spawn_blocking(move || {
                registry.issue(
                    owner_id,
                    window_label,
                    workspace_root,
                    port,
                    generation,
                    canonical_path,
                )
            })
            .await
            .map_err(|error| ("host_operation_failed", error.to_string()))?
            .map_err(|message| ("pick_skill_source_failed", message))?;
            Ok(json!({
                "type": "host_response",
                "requestId": request_id,
                "operation": "pick_skill_source",
                "sourceId": source_id,
            }))
        }
        "skill_scan_install_source" => {
            // Resolve the opaque sourceId to its canonical path (owned by the
            // requesting owner + workspace), then run discovery in Rust. The
            // browser never sees the path — only the opaque scan tree.
            let source_id = frame
                .get("sourceId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or(("invalid_source", "sourceId is required".into()))?
                .to_owned();
            let workspace_id = frame
                .get("workspaceId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or((
                    "invalid_workspace",
                    "workspaceId is required to scan a skill source".into(),
                ))?
                .to_owned();
            let workspace_root = state
                .data
                .workspace_root_path(&workspace_id)
                .map_err(host_data_error)?;
            let owner_id = crate::window_owner::OwnerId::from_client_id(client_id);
            let window_label = client_id.to_owned();
            let generation = 0u64;
            let registry = state.skill_registry.clone();
            let binding = tokio::task::spawn_blocking(move || {
                registry.resolve(
                    &source_id,
                    &owner_id,
                    &window_label,
                    &workspace_root,
                    generation,
                )
            })
            .await
            .map_err(|error| ("host_operation_failed", error.to_string()))?
            .map_err(|message| ("skill_scan_failed", message))?;
            let agent_dir = dirs::home_dir()
                .unwrap_or_else(std::env::temp_dir)
                .join(".pi")
                .join("agent");
            let install_secret = state.install_secret.clone();
            let context = crate::skill_install::InstallContext {
                agent_dir,
                cwd: binding.workspace_root.clone(),
                install_secret,
            };
            let result = tokio::task::spawn_blocking(move || {
                crate::skill_install::scan_install_source(&binding, &context)
            })
            .await
            .map_err(|error| ("host_operation_failed", error.to_string()))?;
            serde_json::to_value(&result)
                .map(|scan| {
                    json!({
                        "type": "host_response",
                        "requestId": request_id,
                        "operation": "skill_scan_install_source",
                        "scan": scan,
                    })
                })
                .map_err(|error| ("host_operation_failed", error.to_string()))
        }
        "skill_install_links" => {
            let source_id = frame
                .get("sourceId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or(("invalid_source", "sourceId is required".into()))?
                .to_owned();
            let scope = frame
                .get("scope")
                .and_then(Value::as_str)
                .filter(|value| *value == "global" || *value == "project")
                .ok_or((
                    "invalid_scope",
                    "scope must be 'global' or 'project'".into(),
                ))?
                .to_owned();
            let scan_revision = frame
                .get("scanRevision")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or(("invalid_revision", "scanRevision is required".into()))?
                .to_owned();
            let selection = frame
                .get("selection")
                .and_then(Value::as_array)
                .filter(|items| !items.is_empty())
                .ok_or(("invalid_selection", "selection array is required".into()))?;
            let workspace_id = frame
                .get("workspaceId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or((
                    "invalid_workspace",
                    "workspaceId is required to install skill links".into(),
                ))?
                .to_owned();
            // Parse the selection into the typed shape the install module
            // expects, rejecting malformed entries.
            let parsed_selection: Vec<crate::skill_install::InstallCandidateSelection> = selection
                .iter()
                .map(|item| {
                    let kind = item
                        .get("kind")
                        .and_then(Value::as_str)
                        .filter(|k| *k == "group" || *k == "skill")
                        .ok_or("invalid selection entry: kind")?;
                    let id = item
                        .get("id")
                        .and_then(Value::as_str)
                        .filter(|v| !v.is_empty())
                        .ok_or("invalid selection entry: id")?;
                    Ok(crate::skill_install::InstallCandidateSelection {
                        kind: kind.to_string(),
                        id: id.to_string(),
                    })
                })
                .collect::<Result<_, String>>()
                .map_err(|message| ("invalid_selection", message))?;
            let workspace_root = state
                .data
                .workspace_root_path(&workspace_id)
                .map_err(host_data_error)?;
            let owner_id = crate::window_owner::OwnerId::from_client_id(client_id);
            let window_label = client_id.to_owned();
            let generation = 0u64;
            let registry = state.skill_registry.clone();
            let binding = tokio::task::spawn_blocking(move || {
                registry.resolve(
                    &source_id,
                    &owner_id,
                    &window_label,
                    &workspace_root,
                    generation,
                )
            })
            .await
            .map_err(|error| ("host_operation_failed", error.to_string()))?
            .map_err(|message| ("skill_install_failed", message))?;
            // On success, consume the sourceId so it cannot be reused — the
            // design contract makes a successful install consume the handle.
            let agent_dir = dirs::home_dir()
                .unwrap_or_else(std::env::temp_dir)
                .join(".pi")
                .join("agent");
            let install_secret = state.install_secret.clone();
            let context = crate::skill_install::InstallContext {
                agent_dir,
                cwd: binding.workspace_root.clone(),
                install_secret,
            };
            let binding_clone = binding.clone();
            let scope_clone = scope.clone();
            let scan_revision_clone = scan_revision.clone();
            let result = tokio::task::spawn_blocking(move || {
                crate::skill_install::install_links(
                    &binding_clone,
                    &scope_clone,
                    &scan_revision_clone,
                    &parsed_selection,
                    &context,
                )
            })
            .await
            .map_err(|error| ("host_operation_failed", error.to_string()))?
            .map_err(|message| ("skill_install_failed", message))?;
            // Consume the handle after a successful install.
            let registry = state.skill_registry.clone();
            let _ = tokio::task::spawn_blocking(move || {
                registry.consume(
                    &binding.source_id,
                    &binding.owner_id,
                    binding.workspace_generation,
                )
            })
            .await;
            serde_json::to_value(&result)
                .map(|value| {
                    json!({
                        "type": "host_response",
                        "requestId": request_id,
                        "operation": "skill_install_links",
                        "result": value,
                    })
                })
                .map_err(|error| ("host_operation_failed", error.to_string()))
        }
        "session_ui_profile_load" => {
            // Look up the persisted provider/modelId/thinkingLevel for a
            // session. The frontend identifies the session by its runtime
            // sessionId (stable for the lifetime of the underlying file);
            // we accept any non-empty string as a key — the store trims and
            // bounds-checks internally.
            let expected = frame
                .get("expectedSessionId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or(("invalid_session", "expectedSessionId is required".into()))?
                .to_owned();
            let profiles = state.session_ui_profiles.clone();
            let profile = tokio::task::spawn_blocking(move || profiles.load(&expected))
                .await
                .map_err(|error| ("host_operation_failed", error.to_string()))?
                .map_err(|message| ("session_ui_profile_load_failed", message))?;
            Ok(json!({
                "type": "host_response",
                "requestId": request_id,
                "operation": "session_ui_profile_load",
                "profile": profile,
            }))
        }
        "session_ui_profile_save" => {
            let expected = frame
                .get("expectedSessionId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or(("invalid_session", "expectedSessionId is required".into()))?
                .to_owned();
            let provider = frame
                .get("provider")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or(("invalid_provider", "provider is required".into()))?
                .to_owned();
            let model_id = frame
                .get("modelId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or(("invalid_model", "modelId is required".into()))?
                .to_owned();
            let thinking_level = frame
                .get("thinkingLevel")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| "off".to_string());
            let profiles = state.session_ui_profiles.clone();
            let saved = tokio::task::spawn_blocking(move || {
                profiles.save(&expected, &provider, &model_id, &thinking_level)
            })
            .await
            .map_err(|error| ("host_operation_failed", error.to_string()))?
            .map_err(|message| ("session_ui_profile_save_failed", message))?;
            Ok(json!({
                "type": "host_response",
                "requestId": request_id,
                "operation": "session_ui_profile_save",
                "profile": saved,
            }))
        }
        "restart_runtime" => {
            let workspace_id = frame
                .get("workspaceId")
                .and_then(Value::as_str)
                .ok_or(("invalid_workspace", "workspaceId is required".into()))?
                .to_owned();
            let session_id = frame
                .get("sessionId")
                .and_then(Value::as_str)
                .ok_or(("invalid_session", "sessionId is required".into()))?
                .to_owned();
            let session_path = state
                .data
                .resolve_session_path(&workspace_id, &session_id)
                .ok()
                .flatten();
            let cwd = state.data.workspace_root_path(&workspace_id).map_err(|_| {
                (
                    "workspace_not_found",
                    "Could not resolve workspace root".into(),
                )
            })?;
            let cwd = cwd.to_string_lossy().to_string();
            let session_path_str = session_path
                .as_ref()
                .map(|p| p.to_string_lossy().to_string());
            let spec = state
                .pi_launch
                .native_launch_spec(&cwd, session_path_str.as_deref())
                .map_err(|message| ("launch_spec_failed", message))?;
            let target =
                RuntimeTarget::new(workspace_id, session_id, "restart-pending".to_string());
            let runtimes = state.runtimes.clone();
            let new_instance = tokio::task::spawn_blocking(move || runtimes.restart(&target, spec))
                .await
                .map_err(|error| ("host_operation_failed", error.to_string()))?
                .map_err(|message| ("restart_runtime_failed", message))?;
            Ok(json!({
                "type": "host_response",
                "requestId": request_id,
                "operation": "restart_runtime",
                "instanceId": new_instance,
                "ok": true,
            }))
        }
        _ => Err((
            "host_operation_unimplemented",
            "Host operation is not implemented on protocol v2".into(),
        )),
    }
}

fn host_data_error(error: HostDataError) -> (&'static str, String) {
    match error {
        HostDataError::UnknownWorkspace => {
            ("workspace_not_found", "Workspace is not registered".into())
        }
        HostDataError::InvalidRelativePath | HostDataError::OutsideWorkspace => (
            "path_outside_workspace",
            "Requested path is outside the registered workspace".into(),
        ),
        HostDataError::NotDirectory => (
            "not_a_directory",
            "Requested path is not a directory".into(),
        ),
        HostDataError::NotFile => ("not_a_file", "Requested path is not a file".into()),
        HostDataError::InvalidMentionQuery => (
            "invalid_mention_query",
            "File mention query is invalid".into(),
        ),
        HostDataError::Io(message) => ("file_access_failed", message),
    }
}

fn host_data_http_error(error: HostDataError) -> (StatusCode, Json<Value>) {
    let status = match error {
        HostDataError::UnknownWorkspace => StatusCode::NOT_FOUND,
        HostDataError::InvalidRelativePath
        | HostDataError::OutsideWorkspace
        | HostDataError::NotDirectory
        | HostDataError::NotFile
        | HostDataError::InvalidMentionQuery => StatusCode::BAD_REQUEST,
        HostDataError::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    let (code, _) = host_data_error(error);
    api_error(status, code)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingExchangeRequest {
    pairing_token: String,
    device_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingExchangeResponse {
    device_token: String,
}

async fn exchange_pairing(
    State(state): State<Arc<HostState>>,
    Json(request): Json<PairingExchangeRequest>,
) -> Result<Json<PairingExchangeResponse>, (StatusCode, Json<Value>)> {
    let token = state
        .auth
        .lock()
        .map_err(|_| api_error(StatusCode::SERVICE_UNAVAILABLE, "auth_unavailable"))?
        .exchange(&request.pairing_token, &request.device_id, now_seconds())
        .map_err(|_| api_error(StatusCode::UNAUTHORIZED, "pairing_rejected"))?;
    Ok(Json(PairingExchangeResponse {
        device_token: token,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceRequestBody {
    device_id: String,
    device_name: String,
    claim_secret: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceClaimBody {
    device_id: String,
    claim_secret: String,
}

fn loopback_peer(peer: ConnectInfo<std::net::SocketAddr>) -> bool {
    peer.0.ip().is_loopback()
}

fn loopback_authority(headers: &HeaderMap, uri: &Uri) -> bool {
    let authority = headers
        .get(axum::http::header::HOST)
        .and_then(|value| value.to_str().ok())
        .or_else(|| uri.authority().map(|authority| authority.as_str()));
    let Some(authority) = authority else {
        return false;
    };
    let Ok(authority) = axum::http::uri::Authority::from_str(authority) else {
        return false;
    };
    let host = authority.host().trim_matches(['[', ']']);
    host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "::1"
}

fn trusted_loopback_request(
    peer: ConnectInfo<std::net::SocketAddr>,
    headers: &HeaderMap,
    uri: &Uri,
) -> bool {
    loopback_peer(peer) && loopback_authority(headers, uri)
}

fn no_store_json(status: StatusCode, value: Value) -> Response {
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json")
        .header(CACHE_CONTROL, "no-store")
        .body(Body::from(value.to_string()))
        .expect("JSON response is valid")
}

async fn create_device_request(
    State(state): State<Arc<HostState>>,
    Json(body): Json<DeviceRequestBody>,
) -> Response {
    let result = state
        .auth
        .lock()
        .map_err(|_| "auth_unavailable")
        .and_then(|mut auth| {
            auth.create_device_request(
                &body.device_id,
                &body.device_name,
                &body.claim_secret,
                now_seconds(),
            )
            .map_err(|error| match error {
                crate::remote_auth::DeviceRequestError::Capacity => "request_capacity",
                crate::remote_auth::DeviceRequestError::RateLimited => "rate_limited",
                crate::remote_auth::DeviceRequestError::Invalid => "invalid_request",
                _ => "request_rejected",
            })
        });
    match result {
        Ok(created) => no_store_json(
            StatusCode::CREATED,
            json!({
                "requestId": created.request_id,
                "expiresAt": created.expires_at,
                "pollAfterMs": 1500,
            }),
        ),
        Err(code) => no_store_json(
            if code == "invalid_request" {
                StatusCode::BAD_REQUEST
            } else if code == "rate_limited" {
                StatusCode::TOO_MANY_REQUESTS
            } else {
                StatusCode::SERVICE_UNAVAILABLE
            },
            json!({ "error": { "code": code } }),
        ),
    }
}

async fn list_device_requests(
    State(state): State<Arc<HostState>>,
    peer: ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    if !trusted_loopback_request(peer, &headers, &uri) {
        return no_store_json(
            StatusCode::FORBIDDEN,
            json!({ "error": { "code": "loopback_required" } }),
        );
    }
    match state.auth.lock() {
        Ok(mut auth) => no_store_json(
            StatusCode::OK,
            json!({ "requests": auth.list_device_requests(now_seconds()) }),
        ),
        Err(_) => no_store_json(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "error": { "code": "auth_unavailable" } }),
        ),
    }
}

async fn decide_device_request(
    State(state): State<Arc<HostState>>,
    peer: ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
    request_id: axum::extract::Path<String>,
    approve: bool,
) -> Response {
    if !trusted_loopback_request(peer, &headers, &uri) {
        return no_store_json(
            StatusCode::FORBIDDEN,
            json!({ "error": { "code": "loopback_required" } }),
        );
    }
    let result = state
        .auth
        .lock()
        .map_err(|_| crate::remote_auth::DeviceRequestError::Storage("auth unavailable".into()))
        .and_then(|mut auth| auth.decide_device_request(&request_id, approve, now_seconds()));
    match result {
        Ok(()) => no_store_json(
            StatusCode::OK,
            json!({ "status": if approve { "approved" } else { "denied" } }),
        ),
        Err(
            crate::remote_auth::DeviceRequestError::NotFound
            | crate::remote_auth::DeviceRequestError::Denied
            | crate::remote_auth::DeviceRequestError::Expired,
        ) => no_store_json(
            StatusCode::GONE,
            json!({ "error": { "code": "already_handled" } }),
        ),
        Err(_) => no_store_json(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "error": { "code": "auth_unavailable" } }),
        ),
    }
}

async fn approve_device_request(
    state: State<Arc<HostState>>,
    peer: ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
    request_id: axum::extract::Path<String>,
) -> Response {
    decide_device_request(state, peer, headers, uri, request_id, true).await
}

async fn deny_device_request(
    state: State<Arc<HostState>>,
    peer: ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
    request_id: axum::extract::Path<String>,
) -> Response {
    decide_device_request(state, peer, headers, uri, request_id, false).await
}

async fn claim_device_request(
    State(state): State<Arc<HostState>>,
    axum::extract::Path(request_id): axum::extract::Path<String>,
    Json(body): Json<DeviceClaimBody>,
) -> Response {
    let result = state
        .auth
        .lock()
        .map_err(|_| crate::remote_auth::DeviceRequestError::Storage("auth unavailable".into()))
        .and_then(|mut auth| {
            auth.claim_device_request(
                &request_id,
                &body.device_id,
                &body.claim_secret,
                now_seconds(),
            )
        });
    match result {
        Ok(crate::remote_auth::DeviceClaim::Pending) => {
            no_store_json(StatusCode::ACCEPTED, json!({ "status": "pending" }))
        }
        Ok(crate::remote_auth::DeviceClaim::Approved(token)) => no_store_json(
            StatusCode::OK,
            json!({ "status": "approved", "deviceToken": token }),
        ),
        Err(crate::remote_auth::DeviceRequestError::Denied) => {
            no_store_json(StatusCode::FORBIDDEN, json!({ "status": "denied" }))
        }
        Err(
            crate::remote_auth::DeviceRequestError::Expired
            | crate::remote_auth::DeviceRequestError::NotFound,
        ) => no_store_json(
            StatusCode::GONE,
            json!({ "error": { "code": "request_expired" } }),
        ),
        Err(
            crate::remote_auth::DeviceRequestError::WrongSecret
            | crate::remote_auth::DeviceRequestError::WrongDevice,
        ) => no_store_json(
            StatusCode::UNAUTHORIZED,
            json!({ "error": { "code": "claim_rejected" } }),
        ),
        Err(crate::remote_auth::DeviceRequestError::Invalid) => no_store_json(
            StatusCode::BAD_REQUEST,
            json!({ "error": { "code": "invalid_request" } }),
        ),
        Err(_) => no_store_json(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "error": { "code": "auth_unavailable" } }),
        ),
    }
}

fn api_error(status: StatusCode, code: &'static str) -> (StatusCode, Json<Value>) {
    (status, Json(json!({ "error": { "code": code } })))
}

fn api_error_with_detail(
    status: StatusCode,
    code: &'static str,
    message: &str,
) -> (StatusCode, Json<Value>) {
    (
        status,
        Json(json!({ "error": { "code": code, "message": message } })),
    )
}

async fn send_error(
    socket: &mut WebSocket,
    request_id: Option<&str>,
    code: &'static str,
    message: &str,
) -> Result<(), axum::Error> {
    socket
        .send(Message::Text(
            structured_error(request_id, code, message)
                .to_string()
                .into(),
        ))
        .await
}

fn structured_error(request_id: Option<&str>, code: &'static str, message: &str) -> Value {
    json!({
        "type": "error",
        "requestId": request_id,
        "error": { "code": code, "message": message },
    })
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::{
        append_pairing_token, extension_ui_requires_owner, messages_from_entries_response,
        now_seconds, trusted_loopback_request, HostServer,
    };
    use crate::metadata_store::MetadataStore;
    use crate::native_pi_manager::NativePiManager;
    use crate::remote_auth::RemoteAuth;
    use crate::runtime_coordinator::RuntimeTarget;
    use futures_util::{SinkExt, StreamExt};
    use serde_json::json;
    use std::fs;
    use std::sync::{Arc, Mutex};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn appends_pairing_token_to_lan_deep_link() {
        let mut plain = "http://192.168.1.10:9000/app/workspaces/a/sessions/b".to_string();
        append_pairing_token(&mut plain, "picot_pair_a+b");
        assert_eq!(
            plain,
            "http://192.168.1.10:9000/app/workspaces/a/sessions/b?pairingToken=picot%5Fpair%5Fa%2Bb"
        );

        let mut with_query =
            "http://192.168.1.10:9000/app/workspaces/a/sessions/b?tab=settings".to_string();
        append_pairing_token(&mut with_query, "token");
        assert_eq!(
            with_query,
            "http://192.168.1.10:9000/app/workspaces/a/sessions/b?tab=settings&pairingToken=token"
        );
    }

    #[test]
    fn loopback_authority_requires_actual_peer_and_accepts_supported_hosts() {
        use axum::extract::connect_info::ConnectInfo;
        use axum::http::{HeaderMap, HeaderValue, Uri};
        use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

        let peer = ConnectInfo(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 1));
        let uri = Uri::from_static("/health");
        for host in [
            "localhost",
            "localhost:57620",
            "127.0.0.1:57620",
            "[::1]:57620",
        ] {
            let mut headers = HeaderMap::new();
            headers.insert("host", HeaderValue::from_static(host));
            assert!(trusted_loopback_request(peer, &headers, &uri), "{host}");
        }
        assert!(trusted_loopback_request(
            peer,
            &HeaderMap::new(),
            &Uri::from_static("http://localhost:57620/health"),
        ));
        let mut external = HeaderMap::new();
        external.insert("host", HeaderValue::from_static("remote.example"));
        assert!(!trusted_loopback_request(peer, &external, &uri));
        let non_loopback = ConnectInfo(SocketAddr::new(
            IpAddr::V4(Ipv4Addr::new(192, 168, 1, 10)),
            1,
        ));
        let mut spoofed = HeaderMap::new();
        spoofed.insert("host", HeaderValue::from_static("127.0.0.1:57620"));
        assert!(!trusted_loopback_request(non_loopback, &spoofed, &uri));
        let ipv6_peer = ConnectInfo(SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), 1));
        assert!(!trusted_loopback_request(ipv6_peer, &external, &uri));
        let mut ipv6_headers = HeaderMap::new();
        ipv6_headers.insert("host", HeaderValue::from_static("[::1]:57620"));
        assert!(trusted_loopback_request(ipv6_peer, &ipv6_headers, &uri));
    }

    #[test]
    fn only_blocking_extension_ui_requests_require_the_session_owner() {
        assert!(extension_ui_requires_owner(&json!({
            "type": "extension_ui_request",
            "method": "select"
        })));
        assert!(!extension_ui_requires_owner(&json!({
            "type": "extension_ui_request",
            "method": "notify",
            "message": "{\"__picotConfig\":\"cfg-1\",\"ok\":true}"
        })));
        assert!(!extension_ui_requires_owner(&json!({
            "type": "agent_start"
        })));
    }

    #[test]
    fn derives_active_branch_messages_with_user_entry_ids_from_entries() {
        let response = json!({
            "type": "response",
            "command": "get_entries",
            "success": true,
            "data": {
                "leafId": "assistant-2",
                "entries": [
                    {
                        "type": "message",
                        "id": "user-1",
                        "parentId": null,
                        "message": { "role": "user", "content": "first" }
                    },
                    {
                        "type": "message",
                        "id": "assistant-1",
                        "parentId": "user-1",
                        "message": { "role": "assistant", "content": [{ "type": "text", "text": "old" }] }
                    },
                    {
                        "type": "message",
                        "id": "user-abandoned",
                        "parentId": "assistant-1",
                        "message": { "role": "user", "content": "abandoned" }
                    },
                    {
                        "type": "message",
                        "id": "user-2",
                        "parentId": "assistant-1",
                        "message": { "role": "user", "content": "current" }
                    },
                    {
                        "type": "message",
                        "id": "assistant-2",
                        "parentId": "user-2",
                        "message": { "role": "assistant", "content": [{ "type": "text", "text": "new" }] }
                    }
                ]
            }
        });

        let messages = messages_from_entries_response(&response);

        assert_eq!(
            messages,
            json!([
                { "role": "user", "content": "first", "entryId": "user-1" },
                { "role": "assistant", "content": [{ "type": "text", "text": "old" }] },
                { "role": "user", "content": "current", "entryId": "user-2" },
                { "role": "assistant", "content": [{ "type": "text", "text": "new" }] }
            ])
        );
    }

    #[tokio::test]
    async fn serves_health_and_static_assets_from_one_origin() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("picot-host-{nonce}"));
        let public = temp.join("public");
        fs::create_dir_all(&public).unwrap();
        fs::write(public.join("index.html"), "<h1>Picot native host</h1>").unwrap();
        let metadata = MetadataStore::open(&temp.join("picot.sqlite3")).unwrap();
        let auth = Arc::new(Mutex::new(RemoteAuth::new(Arc::new(Mutex::new(metadata)))));
        let host = HostServer::start(public, NativePiManager::new(32), auth, None)
            .await
            .unwrap();

        let root = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap()
            .get(format!("{}/", host.origin()))
            .send()
            .await
            .unwrap();
        assert_eq!(root.status(), reqwest::StatusCode::TEMPORARY_REDIRECT);
        assert_eq!(root.headers().get("location").unwrap(), "/app");

        let health: serde_json::Value = reqwest::get(format!("{}/health", host.origin()))
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(health["protocolVersion"], 2);
        assert_eq!(health["piVersion"], env!("PI_STUDIO_PI_VERSION_BUNDLED"));
        let index = reqwest::get(format!("{}/app/settings", host.origin()))
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert!(index.contains("Picot native host"));

        host.stop();
        fs::remove_dir_all(temp).unwrap();
    }

    #[tokio::test]
    async fn protects_http_data_and_legacy_qr_by_authority_and_bearer() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("picot-host-auth-boundary-{nonce}"));
        let public = temp.join("public");
        fs::create_dir_all(&public).unwrap();
        fs::write(public.join("index.html"), "Picot").unwrap();
        let metadata = MetadataStore::open(&temp.join("picot.sqlite3")).unwrap();
        let auth = Arc::new(Mutex::new(RemoteAuth::new(Arc::new(Mutex::new(metadata)))));
        let host = HostServer::start(public, NativePiManager::new(32), auth, None)
            .await
            .unwrap();
        let client = reqwest::Client::new();
        let runtime_url = format!("{}/health/runtime", host.origin());

        let loopback = client.get(&runtime_url).send().await.unwrap();
        assert!(loopback.status().is_success());

        let external_authority = client
            .get(&runtime_url)
            .header("host", "remote.example")
            .send()
            .await
            .unwrap();
        assert_eq!(
            external_authority.status(),
            reqwest::StatusCode::UNAUTHORIZED
        );

        let invalid_bearer = client
            .get(&runtime_url)
            .header("host", "remote.example")
            .bearer_auth("invalid-token")
            .send()
            .await
            .unwrap();
        assert_eq!(invalid_bearer.status(), reqwest::StatusCode::UNAUTHORIZED);

        let pairing = host
            .state
            .auth
            .lock()
            .unwrap()
            .create_pairing(now_seconds());
        let device_token = host
            .state
            .auth
            .lock()
            .unwrap()
            .exchange(&pairing.token, "integration-device", now_seconds())
            .unwrap();
        let bearer = client
            .get(&runtime_url)
            .header("host", "remote.example")
            .bearer_auth(&device_token)
            .send()
            .await
            .unwrap();
        assert!(bearer.status().is_success());

        let lan_qr = client
            .get(format!("{}/v2/lan-qr", host.origin()))
            .header("host", "remote.example")
            .send()
            .await
            .unwrap();
        assert_eq!(lan_qr.status(), reqwest::StatusCode::UNAUTHORIZED);

        host.state
            .auth
            .lock()
            .unwrap()
            .revoke("integration-device")
            .unwrap();
        let revoked = client
            .get(&runtime_url)
            .header("host", "remote.example")
            .bearer_auth(&device_token)
            .send()
            .await
            .unwrap();
        assert_eq!(revoked.status(), reqwest::StatusCode::UNAUTHORIZED);

        host.stop();
        fs::remove_dir_all(temp).unwrap();
    }

    #[tokio::test]
    async fn serves_static_assets_under_a_content_fingerprinted_path() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("picot-host-versioned-{nonce}"));
        let public = temp.join("public");
        fs::create_dir_all(public.join("native")).unwrap();
        fs::write(
            public.join("index.html"),
            "<html><head><base href=\"/\" /></head><body>Picot</body></html>",
        )
        .unwrap();
        fs::write(public.join("native/app.js"), "export const marker = 1;").unwrap();
        let metadata = MetadataStore::open(&temp.join("picot.sqlite3")).unwrap();
        let auth = Arc::new(Mutex::new(RemoteAuth::new(Arc::new(Mutex::new(metadata)))));
        let host = HostServer::start(public, NativePiManager::new(32), auth, None)
            .await
            .unwrap();

        // The entry document's <base> should point at a `/v/<fingerprint>/`
        // path derived from the bundle contents, not the literal "/" that's
        // on disk — every relative script/import resolves under it.
        let index = reqwest::get(format!("{}/app/settings", host.origin()))
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        let base_start = index.find("<base href=\"").unwrap() + "<base href=\"".len();
        let base_end = index[base_start..].find('"').unwrap();
        let base_href = &index[base_start..base_start + base_end];
        assert!(
            base_href.starts_with("/v/") && base_href.ends_with('/'),
            "expected a versioned base href, got {base_href:?}"
        );

        // The versioned path actually serves the underlying files.
        let app_js = reqwest::get(format!("{}{}native/app.js", host.origin(), base_href))
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert_eq!(app_js, "export const marker = 1;");

        host.stop();
        fs::remove_dir_all(temp).unwrap();
    }

    #[tokio::test]
    async fn health_runtime_reports_zero_runtimes_when_idle() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("picot-host-runtime-{nonce}"));
        let public = temp.join("public");
        fs::create_dir_all(&public).unwrap();
        fs::write(public.join("index.html"), "<h1>Picot native host</h1>").unwrap();
        let metadata = MetadataStore::open(&temp.join("picot.sqlite3")).unwrap();
        let auth = Arc::new(Mutex::new(RemoteAuth::new(Arc::new(Mutex::new(metadata)))));
        let host = HostServer::start(public, NativePiManager::new(32), auth, None)
            .await
            .unwrap();

        let body: serde_json::Value = reqwest::get(format!("{}/health/runtime", host.origin()))
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(body["status"], "ok");
        assert_eq!(body["runtimeCount"], 0);
        assert!(body["runtimes"].as_array().unwrap().is_empty());

        host.stop();
        fs::remove_dir_all(temp).unwrap();
    }

    #[tokio::test]
    async fn health_model_test_reports_connectivity_failure_for_unreachable_provider() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("picot-host-model-test-{nonce}"));
        let public = temp.join("public");
        fs::create_dir_all(&public).unwrap();
        fs::write(public.join("index.html"), "<h1>Picot native host</h1>").unwrap();
        let metadata = MetadataStore::open(&temp.join("picot.sqlite3")).unwrap();
        let auth = Arc::new(Mutex::new(RemoteAuth::new(Arc::new(Mutex::new(metadata)))));
        let host = HostServer::start(public, NativePiManager::new(32), auth, None)
            .await
            .unwrap();

        let client = reqwest::Client::new();
        let response = client
            .post(format!("{}/health/models/test", host.origin()))
            .json(&json!({
                "providerName": "probe-unreachable",
                "provider": {
                    "baseUrl": "https://model-test.invalid",
                    "api": "openai-completions",
                    "apiKey": "literal-test-key",
                },
                "model": { "id": "does-not-matter" },
            }))
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success());
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(body["ok"], false);
        assert!(body["error"].as_str().is_some());

        host.stop();
        fs::remove_dir_all(temp).unwrap();
    }

    #[tokio::test]
    async fn health_model_test_rejects_missing_model_id() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("picot-host-model-test-invalid-{nonce}"));
        let public = temp.join("public");
        fs::create_dir_all(&public).unwrap();
        fs::write(public.join("index.html"), "<h1>Picot native host</h1>").unwrap();
        let metadata = MetadataStore::open(&temp.join("picot.sqlite3")).unwrap();
        let auth = Arc::new(Mutex::new(RemoteAuth::new(Arc::new(Mutex::new(metadata)))));
        let host = HostServer::start(public, NativePiManager::new(32), auth, None)
            .await
            .unwrap();

        let client = reqwest::Client::new();
        let response = client
            .post(format!("{}/health/models/test", host.origin()))
            .json(&json!({
                "providerName": "probe",
                "provider": {},
                "model": {},
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::BAD_REQUEST);

        host.stop();
        fs::remove_dir_all(temp).unwrap();
    }

    #[tokio::test]
    async fn bearer_authenticated_external_authority_cannot_mint_pairings_or_claim_desktop() {
        use axum::http::header::{AUTHORIZATION, HOST};
        use axum::http::HeaderValue;
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("picot-host-ws-auth-boundary-{nonce}"));
        let public = temp.join("public");
        fs::create_dir_all(&public).unwrap();
        fs::write(public.join("index.html"), "Picot").unwrap();
        let metadata = MetadataStore::open(&temp.join("picot.sqlite3")).unwrap();
        let auth = Arc::new(Mutex::new(RemoteAuth::new(Arc::new(Mutex::new(metadata)))));
        let host = HostServer::start(public, NativePiManager::new(32), auth, None)
            .await
            .unwrap();
        let pairing = host
            .state
            .auth
            .lock()
            .unwrap()
            .create_pairing(now_seconds());
        let token = host
            .state
            .auth
            .lock()
            .unwrap()
            .exchange(&pairing.token, "ws-remote", now_seconds())
            .unwrap();
        let ws_url = host.origin().replace("http://", "ws://") + "/v2/ws";
        let mut request = ws_url.into_client_request().unwrap();
        request
            .headers_mut()
            .insert(HOST, HeaderValue::from_static("remote.example"));
        request.headers_mut().insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
        );
        let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                json!({
                    "type": "hello",
                    "protocolVersion": 2,
                    "clientType": "desktop",
                    "clientId": "remote-self-declared-desktop",
                    "deviceToken": token,
                })
                .to_string(),
            ))
            .await
            .unwrap();
        let hello_ack = socket.next().await.unwrap().unwrap();
        assert!(hello_ack.to_text().unwrap().contains("hello_ack"));
        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                json!({
                    "type": "auth_request",
                    "requestId": "auth-remote",
                    "operation": "create_pairing",
                })
                .to_string(),
            ))
            .await
            .unwrap();
        let response = socket.next().await.unwrap().unwrap();
        let response: serde_json::Value =
            serde_json::from_str(response.to_text().unwrap()).unwrap();
        assert_eq!(response["error"]["code"], "auth_forbidden");

        host.stop();
        fs::remove_dir_all(temp).unwrap();
    }

    #[tokio::test]
    async fn sends_runtime_events_only_after_an_explicit_target_subscription() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("picot-host-ws-{nonce}"));
        let public = temp.join("public");
        fs::create_dir_all(&public).unwrap();
        fs::write(public.join("index.html"), "Picot").unwrap();
        let metadata = MetadataStore::open(&temp.join("picot.sqlite3")).unwrap();
        let auth = Arc::new(Mutex::new(RemoteAuth::new(Arc::new(Mutex::new(metadata)))));
        let runtimes = NativePiManager::new(32);
        let target = RuntimeTarget::new("workspace-a", "session-a", "instance-a");
        let mut fake = runtimes.register_in_memory(target.clone()).unwrap();
        let host = HostServer::start(public, runtimes, auth, None)
            .await
            .unwrap();
        let ws_url = host.origin().replace("http://", "ws://") + "/v2/ws";
        let (mut socket, _) = tokio_tungstenite::connect_async(ws_url).await.unwrap();
        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                json!({
                    "type": "hello",
                    "protocolVersion": 2,
                    "clientType": "desktop",
                    "clientId": "desktop-a"
                })
                .to_string(),
            ))
            .await
            .unwrap();
        socket.next().await.unwrap().unwrap();
        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                json!({
                    "type": "runtime_subscribe",
                    "requestId": "subscribe-1",
                    "target": target,
                })
                .to_string(),
            ))
            .await
            .unwrap();
        socket.next().await.unwrap().unwrap();

        fake.write_frame(json!({ "type": "agent_start" }))
            .await
            .unwrap();
        let event = tokio::time::timeout(std::time::Duration::from_secs(1), socket.next())
            .await
            .expect("subscribed runtime event")
            .unwrap()
            .unwrap();
        let event: serde_json::Value = serde_json::from_str(event.to_text().unwrap()).unwrap();
        assert_eq!(event["type"], "runtime_event");
        assert_eq!(event["target"]["sessionId"], "session-a");
        assert_eq!(event["sequence"], 1);

        host.stop();
        fs::remove_dir_all(temp).unwrap();
    }

    #[tokio::test]
    async fn replays_startup_extension_ui_and_routes_the_owners_response_exactly_once() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("picot-host-dialog-{nonce}"));
        let public = temp.join("public");
        fs::create_dir_all(&public).unwrap();
        fs::write(public.join("index.html"), "Picot").unwrap();
        let metadata = MetadataStore::open(&temp.join("picot.sqlite3")).unwrap();
        let auth = Arc::new(Mutex::new(RemoteAuth::new(Arc::new(Mutex::new(metadata)))));
        let runtimes = NativePiManager::new(32);
        let target = RuntimeTarget::new("workspace-a", "session-a", "instance-a");
        let mut fake = runtimes.register_in_memory(target.clone()).unwrap();
        fake.write_frame(json!({
            "type": "extension_ui_request",
            "id": "dialog-1",
            "method": "select",
            "title": "Project trust",
            "options": ["Trust once", "Open untrusted"]
        }))
        .await
        .unwrap();
        tokio::task::yield_now().await;

        let host = HostServer::start(public, runtimes, auth, None)
            .await
            .unwrap();
        let ws_url = host.origin().replace("http://", "ws://") + "/v2/ws";
        let (mut socket, _) = tokio_tungstenite::connect_async(ws_url).await.unwrap();
        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                json!({
                    "type": "hello",
                    "protocolVersion": 2,
                    "clientType": "desktop",
                    "clientId": "owner"
                })
                .to_string(),
            ))
            .await
            .unwrap();
        socket.next().await.unwrap().unwrap();
        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                json!({
                    "type": "runtime_subscribe",
                    "requestId": "subscribe",
                    "target": target,
                })
                .to_string(),
            ))
            .await
            .unwrap();
        socket.next().await.unwrap().unwrap();
        let replay = socket.next().await.unwrap().unwrap();
        let replay: serde_json::Value = serde_json::from_str(replay.to_text().unwrap()).unwrap();
        assert_eq!(replay["event"]["id"], "dialog-1");

        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                json!({
                    "type": "runtime_request",
                    "requestId": "dialog-response",
                    "target": target,
                    "command": {
                        "type": "extension_ui_response",
                        "id": "dialog-1",
                        "value": "Trust once"
                    }
                })
                .to_string(),
            ))
            .await
            .unwrap();
        socket.next().await.unwrap().unwrap();
        assert_eq!(
            fake.read_request().await.unwrap(),
            json!({
                "type": "extension_ui_response",
                "id": "dialog-1",
                "value": "Trust once"
            })
        );

        host.stop();
        fs::remove_dir_all(temp).unwrap();
    }
}
