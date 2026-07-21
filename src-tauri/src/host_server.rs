#![cfg_attr(not(test), allow(dead_code))]

use crate::host_data::{HostDataError, HostDataPlane};
use crate::host_router::{HostRouter, RoutedAction, PROTOCOL_VERSION};
use crate::native_pi_manager::NativePiManager;
use crate::pi_launch::{list_installed_apps, open_external, open_in_app, PiLaunchResolver};
use crate::remote_auth::RemoteAuth;
use crate::runtime_coordinator::{RuntimeStatus, RuntimeTarget};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::Query;
use axum::extract::{DefaultBodyLimit, Json, State};
use axum::http::header::{CACHE_CONTROL, PRAGMA};
use axum::http::{HeaderValue, StatusCode};
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use futures_util::StreamExt;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::oneshot;
use tower::ServiceBuilder;
use tower_http::services::{ServeDir, ServeFile};
#[cfg(debug_assertions)]
use tower_http::set_header::SetResponseHeaderLayer;

const MAX_HTTP_BODY_BYTES: usize = 1024 * 1024;
const MAX_WS_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

struct HostState {
    router: Mutex<HostRouter>,
    runtimes: NativePiManager,
    auth: Arc<Mutex<RemoteAuth>>,
    session_owners: Mutex<std::collections::HashMap<RuntimeTarget, String>>,
    data: HostDataPlane,
    pi_launch: PiLaunchResolver,
    port: u16,
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
    ) -> Result<Self, String> {
        Self::start_with_workspaces(static_dir, runtimes, auth, HashMap::new()).await
    }

    pub async fn start_with_workspaces(
        static_dir: PathBuf,
        runtimes: NativePiManager,
        auth: Arc<Mutex<RemoteAuth>>,
        workspace_roots: HashMap<String, PathBuf>,
    ) -> Result<Self, String> {
        let mut data = HostDataPlane::new(workspace_roots)
            .map_err(|error| format!("Cannot initialize Host data plane: {error:?}"))?;
        if let Some(home) = dirs::home_dir() {
            data = data.with_session_root(home.join(".pi/agent/sessions"));
        }
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::UNSPECIFIED, 0))
            .await
            .map_err(|error| format!("Cannot bind Picot Host: {error}"))?;
        let address = listener
            .local_addr()
            .map_err(|error| format!("Cannot read Picot Host address: {error}"))?;
        // Bind on 0.0.0.0 so LAN clients can reach the server, but always use
        // 127.0.0.1 for the Tauri WebView origin — browsers reject 0.0.0.0 as
        // a destination address.
        let loopback_origin = format!("http://127.0.0.1:{}", address.port());
        let state = Arc::new(HostState {
            router: Mutex::new(HostRouter::new()),
            runtimes,
            auth,
            session_owners: Mutex::new(std::collections::HashMap::new()),
            data,
            pi_launch: PiLaunchResolver::new(static_dir.clone()),
            port: address.port(),
        });
        let index = static_dir.join("index.html");
        let static_service = ServeDir::new(static_dir).fallback(ServeFile::new(index));
        #[cfg(debug_assertions)]
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
        let app = Router::new()
            .route("/health", get(health))
            .route("/v2/ws", get(websocket_upgrade))
            .route("/v2/bootstrap", get(bootstrap_target))
            .route("/v2/sessions", get(list_all_sessions_http))
            .route("/v2/auth/exchange", post(exchange_pairing))
            .route("/v2/lan-qr", get(lan_qr))
            .route("/v2/new-session", post(new_session))
            .fallback_service(static_service)
            .layer(DefaultBodyLimit::max(MAX_HTTP_BODY_BYTES))
            .with_state(state.clone());
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        tokio::spawn(async move {
            if let Err(error) = axum::serve(listener, app)
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
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
}

impl Drop for HostServer {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
}

async fn health(State(state): State<Arc<HostState>>) -> Json<Value> {
    Json(json!({
        "status": "ok",
        "protocolVersion": PROTOCOL_VERSION,
        "piVersion": crate::pi_launch::locked_pi_version(),
        "lanUrl": local_lan_url_with_port(state.port).unwrap_or_default(),
    }))
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
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
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

async fn websocket_upgrade(
    State(state): State<Arc<HostState>>,
    websocket: WebSocketUpgrade,
) -> Response {
    websocket
        .max_message_size(MAX_WS_MESSAGE_BYTES)
        .on_upgrade(move |socket| handle_websocket(socket, state))
}

async fn handle_websocket(mut socket: WebSocket, state: Arc<HostState>) {
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
    if hello.get("clientType").and_then(Value::as_str) == Some("remote") {
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
                .connect(&client_id, &hello)
                .map_err(|error| error.message)
        });
    if let Err(message) = handshake {
        let _ = send_error(&mut socket, None, "handshake_rejected", &message).await;
        return;
    }
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
                        if event.event.get("type").and_then(Value::as_str) == Some("extension_ui_request") {
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
        }
    }
    if let Ok(mut owners) = state.session_owners.lock() {
        owners.retain(|_, owner| owner != &client_id);
    }
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
                let messages_response = state
                    .runtimes
                    .request(
                        &target,
                        json!({ "type": "get_messages" }),
                        None,
                        Duration::from_secs(10),
                    )
                    .await
                    .map_err(|message| ("snapshot_failed", message))?;
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
                        "messages": messages_response.pointer("/data/messages").cloned().unwrap_or_else(|| json!([])),
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
            request_id,
            operation,
            frame,
            ..
        } => dispatch_host_operation(state, &request_id, &operation, &frame).await,
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
    request_id: &str,
    operation: &str,
    frame: &Value,
) -> Result<Value, (&'static str, String)> {
    match operation {
        "list_pi_packages" => {
            let resolver = state.pi_launch.clone();
            let sources = tokio::task::spawn_blocking(move || resolver.list_pi_packages())
                .await
                .map_err(|error| ("host_operation_failed", error.to_string()))?
                .map_err(|message| ("list_pi_packages_failed", message))?;
            Ok(json!({
                "type": "host_response",
                "requestId": request_id,
                "operation": "list_pi_packages",
                "packages": sources,
            }))
        }
        "install_pi_package" | "remove_pi_package" => {
            let source = frame
                .get("source")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or(("invalid_source", "Package source cannot be empty".into()))?
                .to_owned();
            let resolver = state.pi_launch.clone();
            let is_install = operation == "install_pi_package";
            tokio::task::spawn_blocking(move || {
                if is_install {
                    resolver.install_pi_package(&source)
                } else {
                    resolver.remove_pi_package(&source)
                }
            })
            .await
            .map_err(|error| ("host_operation_failed", error.to_string()))?
            .map_err(|message| {
                if is_install {
                    ("install_pi_package_failed", message)
                } else {
                    ("remove_pi_package_failed", message)
                }
            })?;
            Ok(json!({
                "type": "host_response",
                "requestId": request_id,
                "operation": operation,
                "ok": true,
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
        HostDataError::Io(message) => ("file_access_failed", message),
    }
}

fn host_data_http_error(error: HostDataError) -> (StatusCode, Json<Value>) {
    let status = match error {
        HostDataError::UnknownWorkspace => StatusCode::NOT_FOUND,
        HostDataError::InvalidRelativePath
        | HostDataError::OutsideWorkspace
        | HostDataError::NotDirectory => StatusCode::BAD_REQUEST,
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

fn api_error(status: StatusCode, code: &'static str) -> (StatusCode, Json<Value>) {
    (status, Json(json!({ "error": { "code": code } })))
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
    use super::{append_pairing_token, HostServer};
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
        let host = HostServer::start(public, NativePiManager::new(32), auth)
            .await
            .unwrap();

        let health: serde_json::Value = reqwest::get(format!("{}/health", host.origin()))
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(health["protocolVersion"], 2);
        assert_eq!(health["piVersion"], "0.80.10");
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
        let host = HostServer::start(public, runtimes, auth).await.unwrap();
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

        let host = HostServer::start(public, runtimes, auth).await.unwrap();
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
